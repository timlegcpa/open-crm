// esign-reorder-pages: move and delete pages of a draft, or take a whole source document
// out of it. Owner only.
//
// A field sits on a page by POSITION (page_index among the live pages in order), so a
// reorder must move every field with its page and drop the fields of a deleted page.
// remapFieldsForReorder computes that from the FULL page set (not just the pages
// touched), and esign_apply_page_reorder applies the page moves and the field remap in
// one transaction, so a failure part-way can no longer leave fields on the wrong page.
// The browser deletes a page this way too (deleted: true).
//
// action 'delete_document' removes one source document of a draft: its live pages are
// retired through the same remap, and esign_delete_draft_document applies the remap and
// deletes the row (its pages cascade) under the envelope's lock, still draft only. Then
// the document's working object is removed here, because the browser never removes a
// storage object. Storage is not in that transaction: an object whose removal fails has
// no row left, so it is logged, and delete-envelope's full walk of the folder clears it.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { isUuid } from '../_shared/http.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import { call, maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, notDraft, objectBody, rpcRefusal } from '../esign-finalize-envelope/lib/errors.ts';
import { remapFieldsForReorder, type ReorderOperation } from '../esign-finalize-envelope/lib/page-reorder.ts';
import type { EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';

export type ReorderPagesRequest =
  | { action?: 'reorder'; envelope_id: string; operations: Array<{ page_id: string; order?: number; deleted?: boolean }> }
  | { action: 'delete_document'; envelope_id: string; document_id: string };

export interface ReorderPagesResponse {
  ok: true;
}

export const REORDER_PAGES_ERRORS = ['bad_request', 'page_not_found', 'document_not_found', 'not_found', 'not_draft'] as const;

const MAX_OPERATIONS = 1000;
const MAX_ORDER = 100_000;

export interface ReorderPagesDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  storage: Pick<EsignStorage, 'removeWorking'>;
  logSink?: LogSink;
}

const documentNotFound = () => new HttpError(404, 'That document is not in this envelope.', 'document_not_found');

export function createReorderPagesHandler(deps: ReorderPagesDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  return createHandler({
    name: 'esign-reorder-pages',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 65_536,
    logSink: deps.logSink,
    async handle({ body, json, log }) {
      const b = objectBody(body);
      if (b.action === 'delete_document') return json(200, await deleteDocument(b, log));
      if (b.action !== undefined && b.action !== 'reorder') throw badRequest();
      if (!isUuid(b.envelope_id) || !Array.isArray(b.operations) || b.operations.length === 0 || b.operations.length > MAX_OPERATIONS) {
        throw badRequest();
      }
      const envelopeId = b.envelope_id;
      const ops: ReorderOperation[] = [];
      const seen = new Set<string>();
      for (const raw of b.operations) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest();
        const r = raw as Record<string, unknown>;
        if (!isUuid(r.page_id) || seen.has(r.page_id)) throw badRequest();
        seen.add(r.page_id);
        const op: ReorderOperation = { page_id: r.page_id };
        if (r.order !== undefined) {
          if (typeof r.order !== 'number' || !Number.isInteger(r.order) || r.order < 0 || r.order > MAX_ORDER) throw badRequest();
          op.order = r.order;
        }
        if (r.deleted !== undefined) {
          if (typeof r.deleted !== 'boolean') throw badRequest();
          op.deleted = r.deleted;
        }
        // An operation that changes nothing is refused, so a caller cannot skip silently.
        if (op.order === undefined && op.deleted === undefined) throw badRequest();
        ops.push(op);
      }

      const envelope = await maybeOne<{ status: string }>(
        'envelope read',
        db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status !== 'draft') throw notDraft();

      const [pages, fields] = await Promise.all([
        rows<{ id: string; order: number; deleted: boolean }>('page read', db.from('esign_envelope_pages').select('id, order, deleted').eq('envelope_id', envelopeId)),
        rows<{ id: string; page_index: number }>('field read', db.from('esign_envelope_fields').select('id, page_index').eq('envelope_id', envelopeId)),
      ]);
      const known = new Set(pages.map((p) => p.id));
      if (ops.some((o) => !known.has(o.page_id))) throw badRequest('A page is not in this envelope.', 'page_not_found');

      const remap = remapFieldsForReorder(pages, ops, fields);
      try {
        await call(db, 'esign_apply_page_reorder', {
          p_envelope_id: envelopeId,
          p_pages: ops,
          p_field_updates: remap.updates,
          p_field_deletes: remap.deletes,
        });
      } catch (err) {
        const refusal = rpcRefusal(err);
        if (refusal?.code === 'not_found') throw badRequest('A page is not in this envelope.', 'page_not_found');
        // Two live pages on one order (23505): the request's own orders collide.
        if ((err as { code?: string }).code === '23505') throw badRequest('Two pages cannot share one position.', 'bad_request');
        throw refusal ?? err;
      }
      return json(200, { ok: true } satisfies ReorderPagesResponse);
    },
  });

  async function deleteDocument(b: Record<string, unknown>, log: Logger): Promise<ReorderPagesResponse> {
    if (!isUuid(b.envelope_id) || !isUuid(b.document_id)) throw badRequest();
    const envelopeId = b.envelope_id;
    const documentId = b.document_id;
    const envelope = await maybeOne<{ status: string }>(
      'envelope read',
      db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
    );
    if (!envelope) throw envelopeNotFound();
    if (envelope.status !== 'draft') throw notDraft();

    const [pages, fields] = await Promise.all([
      rows<{ id: string; order: number; deleted: boolean; source_document_id: string }>(
        'page read',
        db.from('esign_envelope_pages').select('id, order, deleted, source_document_id').eq('envelope_id', envelopeId),
      ),
      rows<{ id: string; page_index: number }>('field read', db.from('esign_envelope_fields').select('id, page_index').eq('envelope_id', envelopeId)),
    ]);
    const retire: ReorderOperation[] = pages.filter((p) => p.source_document_id === documentId && !p.deleted).map((p) => ({ page_id: p.id, deleted: true }));
    const remap = remapFieldsForReorder(pages, retire, fields);

    let path: string;
    try {
      path = await call<string>(db, 'esign_delete_draft_document', {
        p_envelope_id: envelopeId,
        p_document_id: documentId,
        p_field_updates: remap.updates,
        p_field_deletes: remap.deletes,
      });
    } catch (err) {
      const refusal = rpcRefusal(err);
      // P0002 here is the document (the envelope was just read).
      if (refusal?.code === 'not_found') throw documentNotFound();
      throw refusal ?? err;
    }
    try {
      await deps.storage.removeWorking([path]);
    } catch (err) {
      // The row is gone; this line is the object's only record until the envelope is deleted.
      log.error('working object not removed; it is stranded', err, { envelope_id: envelopeId, document_id: documentId });
    }
    return { ok: true };
  }
}
