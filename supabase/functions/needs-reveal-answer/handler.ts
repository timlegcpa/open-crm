// needs-reveal-answer: show the owner a sensitive answer. Owner only.
//
// A sensitive answer is stored only encrypted (needs-save), and this is the one place it
// is decrypted. Every reveal is audited BEFORE the value is returned, and a failed audit
// write refuses the reveal: an answer read without a record of the read is the thing this
// function exists to prevent. The audit row carries ids only, never the item's label.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import type { AuditEntry } from '../_shared/audit.ts';
import type { LogSink } from '../_shared/log.ts';
import { decryptPii, fromBytea } from '../_shared/crypto.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SensitiveItemRow {
  id: string;
  list_id: string;
  contact_id: string;
  sensitive: boolean;
  /** bytea as PostgREST returns it ('\x..') or bytes; null when unanswered. */
  answer_ciphertext: unknown;
}

export interface RevealDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  piiKey: string | null;
  loadItem(itemId: string): Promise<SensitiveItemRow | null>;
  audit(entry: AuditEntry): Promise<void>;
  logSink?: LogSink;
}

const NOT_FOUND = 'There is no saved answer to show.';

export function createRevealAnswerHandler(deps: RevealDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'needs-reveal-answer',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ body, json, log, principal, ip, userAgent }) {
      const input = (body ?? {}) as { item_id?: unknown };
      if (typeof input.item_id !== 'string' || !UUID.test(input.item_id)) throw new HttpError(400, 'Bad request.', 'bad_request');
      if (!deps.piiKey) {
        log.error('PII_ENCRYPTION_KEY is not set');
        throw new HttpError(503, 'Answers cannot be shown right now.', 'encryption_unavailable');
      }
      const item = await deps.loadItem(input.item_id);
      if (!item || !item.sensitive || item.answer_ciphertext === null || item.answer_ciphertext === undefined) {
        throw new HttpError(404, NOT_FOUND, 'not_found');
      }
      const bytes = fromBytea(item.answer_ciphertext);
      if (bytes.length === 0) throw new HttpError(404, NOT_FOUND, 'not_found');

      // Fail closed: no record, no reveal. createHandler turns a throw into a generic 500.
      await deps.audit({
        actorId: principal.userId,
        action: 'needs.reveal_answer',
        details: { item_id: item.id, list_id: item.list_id, contact_id: item.contact_id },
        ip,
        userAgent,
      });
      const value = await decryptPii(bytes, deps.piiKey);
      return json(200, { value });
    },
  });
}
