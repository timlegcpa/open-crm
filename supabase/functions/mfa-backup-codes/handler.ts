// mfa-backup-codes: issue a fresh set of two-factor backup codes, or revoke the set. For
// the owner and for a client, each for their own account only.
//
//   { action: 'generate' }  replaces the whole set in one transaction
//                           (mfa_backup_codes_replace: delete, insert eight digests, audit)
//                           and returns the codes in plain text, this once
//   { action: 'revoke' }    deletes the set (after two-factor is turned off)
// Any other action is refused: a typo must never replace someone's codes.
//
// Recovery credentials are themselves a credential, so this demands the strongest
// session there is: the door's authorizers (is_owner(), get_client_contact_id(), both
// with the MFA bar and the recovery lockout), then an aal2 token (a fresh authenticator
// check) and mfa_guard_denied for the token's own claims. View as client is refused at
// the door (clientWrites): an owner holding a client's session must never mint or clear
// that client's codes.
//
// Rate limits per user, split by action: generating is rare and manual, while revoking is
// the cleanup step turning two-factor off depends on, so a burst of generates must never
// starve it and leave an old set alive after the factor is gone.

import type { AuthOutcome, ClientPrincipal, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { jwtAssurance } from '../_shared/auth.ts';
import { BACKUP_CODES_PER_SET, generateBackupCode, normalizeBackupCode } from '../_shared/mfa-backup-code.ts';

export interface MfaBackupCodesDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  /** mfa_guard_denied: true when this token must not act (no aal2 with a factor, or issued before a recovery). */
  guardDenied(userId: string, aal: string | null, iat: number | null): Promise<boolean>;
  /** checkUserLimit for this user and action. */
  userLimit(action: 'mfa_backup_codes' | 'mfa_backup_codes_revoke', userId: string, max: number): Promise<RateLimitOutcome>;
  revoke(userId: string): Promise<void>;
  verifiedFactorIds(userId: string): Promise<string[]>;
  nextGeneration(): Promise<number>;
  /** mfa_backup_codes_replace. Throws the database error, whose message carries its sentinel. */
  replace(userId: string, hashes: string[], batchId: string, generation: number): Promise<number>;
  hashCode(compact: string): Promise<string>;
  /** Default: jwtAssurance, the claims of the token the door accepted. */
  assurance?: (token: string) => { aal: string | null; iat: number | null };
  /** Default: generateBackupCode. */
  generateCode?: () => string;
  newId?: () => string;
  logSink?: LogSink;
}

const MFA_REQUIRED = { error: 'Check your authenticator code again first.', code: 'mfa_required' };
const LIMITS = { generate: { action: 'mfa_backup_codes', max: 5 }, revoke: { action: 'mfa_backup_codes_revoke', max: 20 } } as const;

function refuse(r: { status: number; error: string; code: string }): never {
  throw new HttpError(r.status, r.error, r.code);
}

export function createMfaBackupCodesHandler(deps: MfaBackupCodesDeps): (req: Request) => Promise<Response> {
  const generateCode = deps.generateCode ?? generateBackupCode;
  const assurance = deps.assurance ?? jwtAssurance;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return createHandler({
    name: 'mfa-backup-codes',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner, client: deps.authorizeClient },
    clientWrites: true,
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, token, body, json, log }) {
      const action = (body as { action?: unknown } | null)?.action;
      if (action !== 'generate' && action !== 'revoke') {
        return json(400, { error: 'Choose generate or revoke.', code: 'bad_action' });
      }
      const userId = principal.userId;

      // A stolen aal1 session must not mint recovery credentials for the account it holds.
      const { aal, iat } = assurance(token ?? '');
      if (aal !== 'aal2' || (await deps.guardDenied(userId, aal, iat))) return json(403, MFA_REQUIRED);

      const limit = LIMITS[action];
      const outcome = await deps.userLimit(limit.action, userId, limit.max);
      if (outcome === 'limited') refuse(REFUSALS.rateLimited);
      if (outcome !== 'allowed') refuse(REFUSALS.unavailable);

      if (action === 'revoke') {
        // Never touches a reserved code: an in-flight recovery owns it.
        await deps.revoke(userId);
        return json(200, { revoked: true });
      }

      // Codes are a companion to a second factor, never a credential on their own.
      // Revoking skips this on purpose: clearing codes right after turning two-factor off
      // is exactly when it runs.
      if ((await deps.verifiedFactorIds(userId)).length === 0) {
        return json(400, { error: 'Two-factor is not turned on for this account.', code: 'no_verified_factor' });
      }

      // The ordering token is drawn BEFORE the codes are made, so it reflects this
      // request's place in line: of two generates in flight the newer one wins, and the
      // older is refused at replace time instead of silently overwriting the codes the
      // person is looking at.
      const generation = await deps.nextGeneration();
      const codes: string[] = [];
      const hashes: string[] = [];
      for (let i = 0; i < BACKUP_CODES_PER_SET; i++) {
        const code = generateCode();
        const compact = normalizeBackupCode(code);
        if (!compact) throw new Error('a generated code failed normalization');
        codes.push(code);
        hashes.push(await deps.hashCode(compact));
      }

      let stored: number;
      try {
        stored = await deps.replace(userId, hashes, newId(), generation);
      } catch (err) {
        // Matched on the database's own sentinels, never echoed.
        const message = String((err as { message?: unknown } | null)?.message ?? '');
        if (message.includes('stale_generation')) {
          return json(409, { error: 'Newer backup codes were just made. Use those, or make a new set.', code: 'stale_generation' });
        }
        if (message.includes('recovery_in_flight')) {
          return json(409, { error: 'A recovery is in progress for this account. Try again shortly.', code: 'recovery_in_flight' });
        }
        if (message.includes('no_verified_factor')) {
          return json(400, { error: 'Two-factor is not turned on for this account.', code: 'no_verified_factor' });
        }
        throw err;
      }
      if (stored !== BACKUP_CODES_PER_SET) {
        log.error('replace stored an unexpected count', undefined, { stored });
        refuse(REFUSALS.internal);
      }
      // The plain text leaves the server this once.
      return json(200, { codes });
    },
  });
}
