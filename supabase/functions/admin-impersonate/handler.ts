// admin-impersonate: start "View as client". Owner only.
//
// The owner sees the portal through one client's own sign-in, read-only. This mints an
// ordinary session for the client's sign-in user and hands it to the owner's tab, and
// the impersonation_sessions row is what makes that session read-only: every table a
// client can write refuses a write from it (0002, trg_impersonation_read_only), and
// storage refuses its uploads.
//
// The sign-in link never leaves this function. Supabase Auth mints a single-use magic
// link; this function redeems it HERE, takes the session it yields, and records the row
// already bound to that session's id before anything is returned. So there is no link
// for anyone to redeem later (a link redeemed after the row closed, inside its hour,
// would have been a session the end step never revoked), and no moment in which the
// session exists unbound: the database restricts it from its first request. Ending the
// view deletes exactly that session (admin-impersonate-end).
//
// Refused targets:
//   - a contact with no active portal account (404);
//   - a sign-in that is the owner's or the system actor's (403), a second latch behind
//     the database's own refusal to attach those to an account;
//   - a banned sign-in (403): a deactivated person is not shown as if they were active;
//   - a client holding a verified second factor (409). The minted session is aal1, and
//     such a client's data requires aal2, so the owner would see an empty portal.
//
// Rows open longer than eight hours are swept (and their sessions revoked) at the top of
// every start, so a project with no scheduler still closes forgotten rows on next use.
// With one owner that is harmless; a multi-owner build must scope it.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { jwtSessionId } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';

export interface TargetAccount {
  user_id: string;
}

export interface TargetContact {
  email: string | null;
  full_name: string | null;
}

export interface AuthUser {
  id: string;
  email: string | null;
  bannedUntil: string | null;
}

export interface MintedSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number | null;
}

export interface SessionRowInput {
  ownerId: string;
  contactId: string;
  targetUserId: string;
  targetEmail: string;
  targetName: string;
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ImpersonateDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  sweepStale(): Promise<number>;
  /** The contact's active accounts with a sign-in, oldest first. */
  activeAccounts(contactId: string): Promise<TargetAccount[]>;
  loadContact(contactId: string): Promise<TargetContact | null>;
  getAuthUser(userId: string): Promise<AuthUser | null>;
  /** org_profile's owner and system actor. */
  staffIds(): Promise<string[]>;
  /** mfa_guard_denied(user, 'aal1', now): true when an aal1 session of this user would be refused. */
  aal1Refused(userId: string): Promise<boolean>;
  /** Mint a magic link for the address and redeem it at once, server side. */
  mintSession(email: string): Promise<MintedSession>;
  /** Revoke a minted session by its access token (used when the row could not be written). */
  revokeMinted(accessToken: string): Promise<void>;
  /** The impersonation_sessions row, bound at birth. Returns its id. */
  insertSession(row: SessionRowInput): Promise<string>;
  audit(entry: { ownerId: string; details: Record<string, string>; ip: string | null; userAgent: string | null }): Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

export function createImpersonateHandler(deps: ImpersonateDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'admin-impersonate',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const contactId = (body as { contact_id?: unknown } | null)?.contact_id;
      if (!isUuid(contactId)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);

      try {
        await deps.sweepStale();
      } catch (err) {
        log.error('stale sweep failed', err);
      }

      const accounts = await deps.activeAccounts(contactId);
      if (accounts.length === 0) throw new HttpError(404, 'This contact has no active portal account.', 'no_active_account');
      const contact = await deps.loadContact(contactId);
      if (!contact) throw new HttpError(404, 'That contact no longer exists.', 'not_found');

      // Every candidate is checked before one is picked.
      const users = await Promise.all(accounts.map((a) => deps.getAuthUser(a.user_id)));
      const staff = await deps.staffIds();
      if (accounts.some((a) => staff.includes(a.user_id))) {
        throw new HttpError(403, 'That sign-in belongs to the owner.', 'staff_user');
      }
      const at = now().getTime();
      if (users.some((u) => u?.bannedUntil && Date.parse(u.bannedUntil) > at)) {
        throw new HttpError(403, 'This sign-in is blocked.', 'banned');
      }

      const contactEmail = contact.email?.trim().toLowerCase() ?? null;
      const target =
        users.find((u) => u?.email && contactEmail && u.email.toLowerCase() === contactEmail) ?? users.find((u) => u?.email) ?? null;
      if (!target?.email) throw new HttpError(404, 'This contact has no sign-in to view as.', 'no_target');

      if (await deps.aal1Refused(target.id)) {
        throw new HttpError(
          409,
          'This client uses two-factor sign-in, so their portal cannot be viewed without their code.',
          'target_has_mfa',
        );
      }

      let minted: MintedSession;
      try {
        minted = await deps.mintSession(target.email);
      } catch (err) {
        log.error('could not mint the session', err);
        throw new HttpError(500, 'Could not start View as client. Try again.', 'mint_failed');
      }

      const sessionId = jwtSessionId(minted.accessToken);
      const name = contact.full_name?.trim() || target.email;
      let rowId: string | null = null;
      if (sessionId) {
        try {
          rowId = await deps.insertSession({
            ownerId: principal.userId,
            contactId,
            targetUserId: target.id,
            targetEmail: target.email,
            targetName: name,
            sessionId,
            ip,
            userAgent,
          });
        } catch (err) {
          log.error('could not record the session', err);
        }
      } else {
        log.error('the minted token carries no session id');
      }
      if (!rowId) {
        // No row, so nothing would restrict this session: it must not survive. Its tokens
        // never left this function.
        try {
          await deps.revokeMinted(minted.accessToken);
        } catch (err) {
          log.error('could not revoke the unrecorded session', err);
        }
        throw new HttpError(500, 'Could not start View as client. Try again.', 'record_failed');
      }

      try {
        await deps.audit({
          ownerId: principal.userId,
          details: { session_id: rowId, target_contact_id: contactId, target_user_id: target.id },
          ip,
          userAgent,
        });
      } catch (err) {
        log.error('audit failed', err);
      }

      return json(200, {
        session_id: rowId,
        access_token: minted.accessToken,
        refresh_token: minted.refreshToken,
        expires_at: minted.expiresAt,
        contact_id: contactId,
        contact_name: name,
        client_user_id: target.id,
      });
    },
  });
}
