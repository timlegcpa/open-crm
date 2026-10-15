// esign-reorder-pages: move and delete pages of a draft. Owner only.
//
// A field sits on a page by POSITION (page_index among the live pages in order), so a
// reorder must move every field with its page and drop the fields of a deleted page.
// remapFieldsForReorder computes that from the FULL page set (not just the pages
// touched), and esign_apply_page_reorder applies the page moves and the field remap in
// one transaction, so a failure part-way can no longer leave fields on the wrong page.
// The browser deletes a page this way too (deleted: true), since it may not remove a
// working object itself.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { call, maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, notDraft, objectBody, rpcRefusal } from '../esign-finalize-envelope/lib/errors.ts';
import { remapFieldsForReorder, type ReorderOperation } from '../esign-finalize-envelope/lib/page-reorder.ts';

export interface ReorderPagesRequest {
  envelope_id: string;
  operations: Array<{ page_id: string; order?: number; deleted?: boolean }>;
}

export interface ReorderPagesResponse {
  ok: true;
}

export const REORDER_PAGES_ERRORS = ['bad_request', 'page_not_found', 'not_found', 'not_draft'] as const;

const MAX_OPERATIONS = 1000;
const MAX_ORDER = 100_000;

export interface ReorderPagesDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  logSink?: LogSink;
}

export function createReorderPagesHandler(deps: ReorderPagesDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  return createHandler({
    name: 'esign-reorder-pages',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 65_536,
    logSink: deps.logSink,
    async handle({ body, json }) {
      const b = objectBody(body);
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
}
