// esign-manage-fields: place a signer's signature and date boxes on a draft. Owner only.
//
//   set     replaces ONE signer's fields with the given list, in one transaction
//           (esign_set_signer_fields): a failure between the delete and the insert can
//           no longer leave the signer with none. inserted_ids come back in input order,
//           so the editor re-binds each box it drew.
//   remove  deletes one field of this envelope.
//
// The body cap is 128 KiB: 200 boxes overflow the default 16 KiB.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { call, maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, draftWrite, envelopeNotFound, notDraft, objectBody, rpcRefusal, signerNotFound } from '../esign-finalize-envelope/lib/errors.ts';

export interface FieldInput {
  page_index: number;
  field_type: 'signature' | 'date';
  x: number;
  y: number;
  width: number;
  height: number;
  required?: boolean;
}

export type ManageFieldsRequest =
  | { envelope_id: string; action: 'set'; signer_id: string; fields: FieldInput[] }
  | { envelope_id: string; action: 'remove'; field_id: string };

export type ManageFieldsResponse =
  | { success: true; count: number; inserted_ids: string[] }
  | { success: true; ok: true };

export const MANAGE_FIELDS_ERRORS = ['bad_request', 'invalid_fields', 'too_many_fields', 'field_not_found', 'signer_not_found', 'not_found', 'not_draft'] as const;

export const MAX_FIELDS_PER_SIGNER = 200;

export interface ManageFieldsDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  logSink?: LogSink;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A field as stored, or null when any part is out of shape. */
export function validateField(raw: unknown): Required<FieldInput> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (!finite(f.page_index) || !Number.isInteger(f.page_index) || f.page_index < 0 || f.page_index > 199) return null;
  if (f.field_type !== 'signature' && f.field_type !== 'date') return null;
  if (!finite(f.x) || f.x < 0 || !finite(f.y) || f.y < 0) return null;
  if (!finite(f.width) || f.width <= 0 || !finite(f.height) || f.height <= 0) return null;
  if (f.required !== undefined && typeof f.required !== 'boolean') return null;
  return {
    page_index: f.page_index,
    field_type: f.field_type,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required === undefined ? true : f.required,
  };
}

export function createManageFieldsHandler(deps: ManageFieldsDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'esign-manage-fields',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 131_072,
    logSink: deps.logSink,
    async handle({ body, json }) {
      const b = objectBody(body);
      const envelopeId = b.envelope_id;
      if (!isUuid(envelopeId) || (b.action !== 'set' && b.action !== 'remove')) throw badRequest();

      const fields: Required<FieldInput>[] = [];
      if (b.action === 'set') {
        if (!isUuid(b.signer_id) || !Array.isArray(b.fields)) throw badRequest();
        if (b.fields.length > MAX_FIELDS_PER_SIGNER) throw badRequest('A signer can have at most 200 fields.', 'too_many_fields');
        for (const raw of b.fields) {
          const v = validateField(raw);
          if (!v) throw badRequest('A field is out of place or the wrong shape.', 'invalid_fields');
          fields.push(v);
        }
      } else if (!isUuid(b.field_id)) {
        throw badRequest();
      }

      const envelope = await maybeOne<{ status: string }>(
        'envelope read',
        deps.db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status !== 'draft') throw notDraft();

      if (b.action === 'remove') {
        const deleted = await draftWrite(rows(
          'field delete',
          deps.db.from('esign_envelope_fields').delete().eq('id', b.field_id).eq('envelope_id', envelopeId).select('id'),
        ));
        if (deleted.length === 0) throw new HttpError(404, 'That field is not on this envelope.', 'field_not_found');
        return json(200, { success: true, ok: true } satisfies ManageFieldsResponse);
      }

      let ids: string[];
      try {
        ids = await call<string[]>(deps.db, 'esign_set_signer_fields', {
          p_envelope_id: envelopeId,
          p_signer_id: b.signer_id,
          p_fields: fields,
        });
      } catch (err) {
        const refusal = rpcRefusal(err);
        // P0002 here is the signer (the envelope was just read).
        if (refusal?.code === 'not_found') throw signerNotFound();
        throw refusal ?? err;
      }
      return json(200, { success: true, count: ids.length, inserted_ids: ids } satisfies ManageFieldsResponse);
    },
  });
}
