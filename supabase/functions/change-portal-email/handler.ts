// change-portal-email: change the address one portal account signs in with. Owner only.
//
// Two halves, and the ORDER is the correctness property. Auth holds the sign-in, and only
// the server reaches it; the database (0017, portal_set_login_email) holds where
// invitations and requests go. Auth goes FIRST: it is the half that can refuse for a reason
// outside this database (most often an address another sign-in already holds), and a
// refusal there leaves everything unchanged and a retry safe. Database first would leave the
// sign-in on the old address while every invitation went to the new one.
//
// Before Auth, portal_login_for_change checks the request without writing: the account has
// a sign-in, the caller read its current address (a compare-and-swap, so a change built on
// a stale screen fails), and no other open account holds the new one. The database half
// repeats every check under locks. If it refuses after Auth moved (the address changed in
// between), the answer says the sign-in moved and the record did not, and a retry of the
// same request finishes the job: Auth accepts an address it already holds.
//
// The audit row records which account and the outcome, never either address.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { EMAIL_MAX_LEN, normalizeEmail } from '../mcp-crm/validation.ts';

export type CheckOutcome = 'ok' | 'not_found' | 'no_sign_in' | 'stale' | 'unchanged' | 'address_in_use';
export type SetOutcome = 'updated' | Exclude<CheckOutcome, 'ok'>;

export interface ChangeEmailAuditEntry {
  ownerId: string;
  action: 'portal_login_email_changed';
  details: Record<string, string>;
  ip: string | null;
  userAgent: string | null;
}

export interface ChangeEmailDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** portal_login_for_change: may the change go ahead, and which sign-in user. Writes nothing. */
  check(accountId: string, email: string, expected: string | null): Promise<{ outcome: CheckOutcome; user_id?: string; contact_id?: string }>;
  /** Auth's admin update of the user's address, confirmed. 'refused' when Auth refuses; throws when the outcome is unknown. */
  setSignInEmail(userId: string, email: string): Promise<'changed' | 'refused'>;
  /** portal_set_login_email: the database half, under locks. */
  setRecord(accountId: string, email: string, expected: string | null): Promise<{ outcome: SetOutcome; contact_id?: string; contact_address?: string }>;
  audit(entry: ChangeEmailAuditEntry): Promise<void>;
  logSink?: LogSink;
}

const REFUSED: Record<Exclude<CheckOutcome, 'ok'>, { status: number; error: string }> = {
  not_found: { status: 404, error: 'That portal account no longer exists.' },
  no_sign_in: { status: 409, error: 'That account has no sign-in yet, so there is no sign-in address to change. Send a new invitation instead.' },
  stale: { status: 409, error: 'That address changed since this screen loaded. Reload and try again.' },
  unchanged: { status: 409, error: 'The account already signs in with that address.' },
  address_in_use: { status: 409, error: 'Another portal account already uses that address.' },
};

export function createChangePortalEmailHandler(deps: ChangeEmailDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'change-portal-email',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 2048,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const input = (body ?? {}) as { account_id?: unknown; email?: unknown; expected_email?: unknown };
      const bad = () => new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      if (!isUuid(input.account_id)) throw bad();
      const parsed = normalizeEmail(input.email);
      if ('error' in parsed) throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
      const expected = input.expected_email;
      if (expected !== null && (typeof expected !== 'string' || expected.length > EMAIL_MAX_LEN)) throw bad();
      const accountId = input.account_id;
      const email = parsed.email;

      const ready = await deps.check(accountId, email, expected);
      if (ready.outcome !== 'ok') {
        const r = REFUSED[ready.outcome];
        throw new HttpError(r.status, r.error, ready.outcome);
      }

      const moved = await deps.setSignInEmail(ready.user_id as string, email);
      if (moved === 'refused') {
        throw new HttpError(409, 'The sign-in address could not be changed: another sign-in may already use it. Nothing was changed.', 'auth_refused');
      }

      // From here the sign-in has moved: a failure is reported as half done, never as a
      // generic error that reads like nothing happened.
      let record: { outcome: SetOutcome | 'error'; contact_id?: string; contact_address?: string };
      try {
        record = await deps.setRecord(accountId, email, expected);
      } catch (err) {
        log.error('the database half failed after the sign-in moved', err);
        record = { outcome: 'error' };
      }
      try {
        await deps.audit({
          ownerId: principal.userId,
          action: 'portal_login_email_changed',
          details: { contact_id: record.contact_id ?? ready.contact_id ?? '', account_id: accountId, outcome: record.outcome },
          ip,
          userAgent,
        });
      } catch (err) {
        log.error('audit failed', err);
      }
      if (record.outcome !== 'updated') {
        log.warn('the sign-in moved but the record did not', { outcome: record.outcome });
        return json(500, {
          error: 'The sign-in address changed, but the contact record did not. Try again to finish it.',
          code: 'partial_change',
        });
      }
      return json(200, { success: true, contact_address: record.contact_address ?? null });
    },
  });
}
