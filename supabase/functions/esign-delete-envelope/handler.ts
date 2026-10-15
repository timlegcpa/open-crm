// esign-delete-envelope: remove an envelope and its working files. Owner only.
//
// Any status may be deleted, but a COMPLETED envelope only with force: true, and that
// question is asked FIRST, before anything is touched (at the pin the working files were
// already gone when the 409 came back). Then, in order:
//   1. The working folder is listed completely and removed; a partial listing aborts,
//      because once the row is gone nothing could find the objects it missed.
//   2. A completed envelope is snapshotted into esign_completed_tombstones (signers with
//      their names resolved now, the full event log): the cascade below destroys the
//      evidence and the tamper check answers from the tombstone afterwards. A failed
//      snapshot aborts the delete.
//   3. Drawn signature images go, then the envelope row (its children cascade). Without
//      force the delete re-checks that the envelope did not complete meanwhile.
//   4. An audit row: ids, counts and flags only.
// The executed PDF in the documents store, and the documents rows over it, stay: they are
// the record of what was signed, and nothing here removes a documents object.

import type { AuditEntry } from '../_shared/audit.ts';
import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { allRows, byTimeThenId, call, maybeOne, rows, run, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';
import { walkWorking, type EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';

export interface DeleteEnvelopeRequest {
  envelope_id: string;
  /** Required to delete a completed envelope. */
  force?: boolean;
}

export interface DeleteEnvelopeResponse {
  ok: true;
  envelope_id: string;
  working_objects_removed: number;
}

export const DELETE_ENVELOPE_ERRORS = ['bad_request', 'requires_force', 'conflict', 'not_found'] as const;

export interface DeleteEnvelopeDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  storage: EsignStorage;
  audit(entry: AuditEntry): Promise<void>;
  logSink?: LogSink;
}

const SIGNER_SNAPSHOT_COLUMNS =
  'id, contact_id, email, role, status, order, signed_at, signed_ip, signed_user_agent, signed_verification_method, signed_timezone, ' +
  'signed_font, signed_signature_text, signed_signature_kind, consented_at, consent_disclosure_version, phone_last_four, invited_at, ' +
  'opened_email_at, first_viewed_at';

export function createDeleteEnvelopeHandler(deps: DeleteEnvelopeDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  return createHandler({
    name: 'esign-delete-envelope',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      if (!isUuid(b.envelope_id)) throw badRequest();
      const force = b.force === true;
      const envelope = await maybeOne<{
        id: string;
        title: string;
        status: string;
        signed_pdf_path: string | null;
        signed_pdf_sha256: string | null;
        completed_at: string | null;
      }>(
        'envelope read',
        db.from('esign_envelopes').select('id, title, status, signed_pdf_path, signed_pdf_sha256, completed_at').eq('id', b.envelope_id).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      const completed = envelope.status === 'completed';
      if (completed && !force) {
        throw new HttpError(409, 'This envelope is complete. Deleting it also deletes its audit trail, so confirm to continue.', 'requires_force');
      }

      // 1. The working folder, completely, or nothing.
      const paths = await walkWorking(deps.storage, envelope.id);
      await deps.storage.removeWorking(paths);

      // 2. The evidence, before the cascade.
      if (completed) {
        const [signers, events] = await Promise.all([
          rows<Record<string, unknown> & { email: string; role: string; contact_id: string | null; order: number }>(
            'signer snapshot read',
            db.from('esign_envelope_signers').select(SIGNER_SNAPSHOT_COLUMNS).eq('envelope_id', envelope.id),
          ),
          allRows<{ id: string; created_at: string }>('event snapshot read', () =>
            db.from('esign_envelope_events').select('id, signer_id, event_type, ip, user_agent, metadata, created_at').eq('envelope_id', envelope.id)),
        ]);
        const contactIds = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
        const contacts = contactIds.length
          ? await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', contactIds))
          : [];
        const byId = new Map(contacts.map((c) => [c.id, c]));
        const snapshot = signers
          .sort((x, y) => x.order - y.order)
          .map((s) => ({
            ...s,
            name: resolveSignerName({ email: s.email, role: s.role, contact: s.contact_id ? byId.get(s.contact_id) ?? null : null }),
          }));
        await run(
          'tombstone insert',
          db.from('esign_completed_tombstones').insert({
            envelope_id: envelope.id,
            title: envelope.title,
            completed_at: envelope.completed_at,
            signed_pdf_sha256: envelope.signed_pdf_sha256,
            signed_pdf_path: envelope.signed_pdf_path,
            signers: snapshot,
            events: events.sort(byTimeThenId),
            deleted_by: principal.userId,
          }),
        );
      }

      // 3. The row (children cascade), re-checked without force.
      await call(db, 'esign_delete_signature_images_for_envelope', { p_envelope_id: envelope.id });
      let del = db.from('esign_envelopes').delete().eq('id', envelope.id);
      if (!force) del = del.neq('status', 'completed');
      const deleted = await rows('envelope delete', del.select('id'));
      if (deleted.length === 0) {
        throw new HttpError(409, 'This envelope changed while it was being deleted. Reload and try again.', 'conflict');
      }

      // 4. The record that it happened (the envelope's own log went with it).
      try {
        await deps.audit({
          actorId: principal.userId,
          action: 'esign_envelope_deleted',
          details: {
            envelope_id: envelope.id,
            status: envelope.status,
            working_objects_removed: paths.length,
            signed_pdf_sha256: envelope.signed_pdf_sha256,
            tombstoned: completed,
          },
          ip,
          userAgent,
        });
      } catch (err) {
        log.error('audit failed', err, { envelope_id: envelope.id });
      }
      return json(200, { ok: true, envelope_id: envelope.id, working_objects_removed: paths.length } satisfies DeleteEnvelopeResponse);
    },
  });
}
