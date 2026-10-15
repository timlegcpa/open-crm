// lead-intake-key: the owner makes, replaces or removes the lead-intake key. Owner only.
//
//   { action: 'rotate' }  a new key replaces any old one. Only its SHA-256 digest is
//                         stored; the key itself is returned this once and never again.
//   { action: 'revoke' }  removes the key: every delivery is refused until a new one.
// Both are audited (ids and codes only). A replaced or removed key stops working within
// lead-intake's cache time (a minute), not at once.
//
// Not an RPC: the key is made and hashed here, so it never reaches the database in plain
// text.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { KEY_HINT_LENGTH, newLeadIntakeKey } from '../lead-intake/key.ts';

export interface LeadIntakeKeyDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** checkUserLimit for 'lead_intake_key'. */
  userLimit(userId: string): Promise<RateLimitOutcome>;
  /** Upsert the one row (id true). */
  saveKey(row: { key_hash: string; key_hint: string; created_by: string }): Promise<void>;
  deleteKey(): Promise<void>;
  audit(ownerId: string, action: 'lead_intake_key_rotated' | 'lead_intake_key_revoked'): Promise<void>;
  /** Default: newLeadIntakeKey. */
  newKey?: () => string;
  logSink?: LogSink;
}

export function createLeadIntakeKeyHandler(deps: LeadIntakeKeyDeps): (req: Request) => Promise<Response> {
  const newKey = deps.newKey ?? newLeadIntakeKey;

  return createHandler({
    name: 'lead-intake-key',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log }) {
      const action = (body as { action?: unknown } | null)?.action;
      if (action !== 'rotate' && action !== 'revoke') {
        return json(400, { error: 'Choose rotate or revoke.', code: 'bad_action' });
      }

      const outcome = await deps.userLimit(principal.userId);
      if (outcome === 'limited') throw new HttpError(REFUSALS.rateLimited.status, REFUSALS.rateLimited.error, REFUSALS.rateLimited.code);
      if (outcome !== 'allowed') throw new HttpError(REFUSALS.unavailable.status, REFUSALS.unavailable.error, REFUSALS.unavailable.code);

      const audit = async (what: 'lead_intake_key_rotated' | 'lead_intake_key_revoked') => {
        try {
          await deps.audit(principal.userId, what);
        } catch (err) {
          log.error('audit failed', err);
        }
      };

      if (action === 'revoke') {
        await deps.deleteKey();
        await audit('lead_intake_key_revoked');
        return json(200, { revoked: true });
      }

      const key = newKey();
      await deps.saveKey({ key_hash: await sha256Hex(key), key_hint: key.slice(0, KEY_HINT_LENGTH), created_by: principal.userId });
      await audit('lead_intake_key_rotated');
      return json(200, { key, key_hint: key.slice(0, KEY_HINT_LENGTH) });
    },
  });
}
