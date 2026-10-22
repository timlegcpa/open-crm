// change-portal-email: change the address one portal account signs in with. Owner only.
//
// Two halves, and the ORDER is the correctness property. Auth holds the sign-in, and only
// the server reaches it; the database (0017, portal_set_login_email) holds where
// invitations and requests go. Auth goes FIRST: it is the half that can refuse for a reason
// outside this database (most often an address another sign-in already holds), and a
// refusal there leaves everything unchanged and a retry safe. Database first would leave the
// sign-in on the old address while every invitation went to the new one.
//
// Before Auth, two reads and no writes:
//   * portal_login_for_change: the account has a sign-in, the caller read its current
//     address (a compare-and-swap, so a change built on a stale screen fails), and no other
//     open account holds the new one;
//   * Auth's own record of the user: its address must be the one the caller read, or
//     already the new one (an earlier change that moved the sign-in and not the record,
//     being finished). Anything else is a change made meanwhile, refused before Auth is
//     touched, so two owners' changes cannot both move the sign-in.
// The database half repeats its checks under locks. Every way Auth moved and the record did
// not (a refusal, an error) is answered as half done and audited, and so is an Auth call
// whose outcome is unknown. Either is finished the same way: reopen the record and edit from
// the address it shows.
//
// After a change, the OLD address gets a notice (notice.ts), so a change the client did not
// ask for is noticed. The sign-in's open sessions are NOT ended here: Auth's admin API ends
// sessions only with the user's own token, and the server never holds one.
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
  /** The address Auth holds for the user now (auth.admin.getUserById); null when it holds none. Throws on any failure. */
  currentSignInEmail(userId: string): Promise<string | null>;
  /** Auth's admin update of the user's address, confirmed. 'refused' when Auth refuses; throws when the outcome is unknown. */
  setSignInEmail(userId: string, email: string): Promise<'changed' | 'refused'>;
  /** portal_set_login_email: the database half, under locks. */
  setRecord(accountId: string, email: string, expected: string | null): Promise<{ outcome: SetOutcome; contact_id?: string; contact_address?: string }>;
  /** The "your sign-in email was changed" notice to the old address. Throws when it cannot be sent. */
  sendNotice(input: { to: string; accountId: string; newEmail: string }): Promise<'sent' | 'failed' | 'unknown'>;
  audit(entry: ChangeEmailAuditEntry): Promise<void>;
  logSink?: LogSink;
}

const REOPEN = 'Reopen the record and edit from the address it shows now.';
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

const REFUSED: Record<Exclude<CheckOutcome, 'ok'>, { status: number; error: string }> = {
  not_found: { status: 404, error: 'That portal account no longer exists.' },
  no_sign_in: { status: 409, error: 'That account has no sign-in yet, so there is no sign-in address to change. Send a new invitation instead.' },
  stale: { status: 409, error: `That address changed since this screen loaded. ${REOPEN}` },
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
      const userId = ready.user_id as string;

      const recordOutcome = async (outcome: string, extra: Record<string, string> = {}) => {
        try {
          await deps.audit({
            ownerId: principal.userId,
            action: 'portal_login_email_changed',
            details: { contact_id: ready.contact_id ?? '', account_id: accountId, outcome, ...extra },
            ip,
            userAgent,
          });
        } catch (err) {
          log.error('audit failed', err);
        }
      };

      // Auth's own record: the address the caller read, or already the new one (finishing a
      // change that moved the sign-in and not the record). Anything else moved meanwhile.
      const current = await deps.currentSignInEmail(userId);
      const finishing = same(current, email);
      if (!finishing && !same(current, expected)) {
        throw new HttpError(409, `The sign-in address changed since this screen loaded. ${REOPEN}`, 'stale');
      }

      if (!finishing) {
        let moved: 'changed' | 'refused';
        try {
          moved = await deps.setSignInEmail(userId, email);
        } catch (err) {
          // No clear answer: the sign-in may or may not have moved. Recorded, and said so.
          log.error('the sign-in update got no clear answer', err);
          await recordOutcome('auth_unknown');
          return json(502, {
            error: `The sign-in change got no clear answer, so it may or may not have happened. ${REOPEN}`,
            code: 'sign_in_unknown',
          });
        }
        if (moved === 'refused') {
          throw new HttpError(409, 'The sign-in address could not be changed: another sign-in may already use it. Nothing was changed.', 'auth_refused');
        }
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
      if (record.outcome !== 'updated') {
        log.warn('the sign-in moved but the record did not', { outcome: record.outcome });
        await recordOutcome(record.outcome === 'error' ? 'partial_error' : `partial_${record.outcome}`);
        return json(500, {
          error: `The sign-in address changed, but the contact record did not. ${REOPEN}`,
          code: 'partial_change',
        });
      }

      // The person who held the old address hears of it: the address Auth held, or, when this
      // finished an earlier move, the one the record held. A failed notice never undoes the change.
      const previous = finishing ? expected : current;
      let notice: 'sent' | 'failed' | 'unknown' | 'error' | 'none' = 'none';
      if (previous && !same(previous, email)) {
        try {
          notice = await deps.sendNotice({ to: previous.trim(), accountId, newEmail: email });
        } catch (err) {
          log.error('the sign-in change notice was not sent', err);
          notice = 'error';
        }
      }
      await recordOutcome('updated', { notice });
      return json(200, { success: true, contact_address: record.contact_address ?? null, notice });
    },
  });
}
