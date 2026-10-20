// revoke-portal-access: deactivate one portal account. Owner only.
//
// deactivate_portal_account (0012) sets the row to deactivated and revokes the pending
// links to its address in one transaction. The contact's pending start links are then
// expired: redeeming one creates a fresh active sign-in, so every path that takes access
// away expires them (delete-contact too). The follow-up is the sign-in user's ban: a
// deactivated account must not keep a working password, and the database alone cannot
// stop a token from refreshing. There is no "sign the user out" step: Auth's admin
// sign-out takes a session token, not a user id, and the ban is what ends future sign-ins.
//
// The audit row is written before the follow-up's outcome decides the response, so a
// partial failure is still on record; the owner then retries, which is safe because a
// deactivated account deactivates again without complaint.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { inviteRefusal, type InviteAuditEntry } from '../invite-client-portal/handler.ts';

export interface RevokeDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** The account's contact, or null when the account does not exist. */
  accountContact(accountId: string): Promise<string | null>;
  /** deactivate_portal_account: the sign-in user to ban, or null. */
  deactivate(accountId: string): Promise<string | null>;
  /** Marks every pending start link of the contact expired. */
  expireStartLinks(contactId: string): Promise<void>;
  banUser(userId: string): Promise<void>;
  audit(entry: Omit<InviteAuditEntry, 'action'> & { action: 'portal_access_deactivated' }): Promise<void>;
  logSink?: LogSink;
}

export function createRevokeHandler(deps: RevokeDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'revoke-portal-access',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const accountId = (body as { account_id?: unknown } | null)?.account_id;
      if (!isUuid(accountId)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);

      const contactId = await deps.accountContact(accountId);
      if (!contactId) throw new HttpError(404, 'That portal account no longer exists.', 'not_found');

      let userId: string | null;
      try {
        userId = await deps.deactivate(accountId);
      } catch (err) {
        const refusal = inviteRefusal(err);
        if (refusal) throw refusal;
        throw err;
      }

      // After the deactivate, so a refused deactivate changes nothing. Contact-wide on
      // purpose: once this account is deactivated, the redemption check
      // (start_link_access_revoked) refuses every link of the contact anyway (either no
      // account is active, or one is and a link would make a second sign-in), so this makes
      // them read as what they are. Logged, not fatal, for the same reason; the owner can
      // send a fresh link to anyone who still needs one.
      try {
        await deps.expireStartLinks(contactId);
      } catch (err) {
        log.error('start link expiry failed after deactivating', err);
      }

      let banned = userId === null;
      if (userId) {
        try {
          await deps.banUser(userId);
          banned = true;
        } catch (err) {
          log.error('ban failed after deactivating', err);
        }
      }

      try {
        await deps.audit({
          ownerId: principal.userId,
          action: 'portal_access_deactivated',
          details: { contact_id: contactId, account_id: accountId, sign_in_blocked: banned },
          ip,
          userAgent,
        });
      } catch (err) {
        log.error('audit failed', err);
      }

      if (!banned) {
        return json(500, { error: 'The account was deactivated, but its sign-in could not be blocked. Try again.', code: 'ban_failed' });
      }
      return json(200, { success: true });
    },
  });
}
