// accept-portal-invite: redeem an invitation link. The invitee chooses a password, the
// server creates their sign-in user and links it to the account the invitation opened,
// and the page then signs in with that password.
//
// Public: the token is the credential. The caller's address is rate limited (then a
// shared ceiling) before the body is read, and each invitation allows five attempts,
// counted atomically in the database.
//
// The latches, in order, each of which once failed in the source system:
//   1. The user is CREATED banned and un-banned only after the link lands, so every
//      failure in between leaves an account that cannot sign in, never a working
//      password on a login with no account behind it.
//   2. The link (link_portal_invitation) refuses a row a contact delete has claimed and a
//      row another acceptance already linked. If it matches nothing, the new user is
//      banned again and deleted, and the invitation stays redeemable.
//   3. An address that is already registered is deleted and retried ONLY when that user
//      is stamped with THIS invitation's id (pending_invite, set at create, cleared at
//      un-ban), is still banned, AND is an abandoned attempt (no account) or one on this
//      contact. The contact match alone once let a replayed token replace a live login's
//      password. The check and the delete are one statement (delete_stale_portal_user).
//   4. Un-ban and the stamp's clearing are one call.
//   5. One acceptance at a time per invitation (claim_portal_invitation, held to the end).
//      Two at once once raced: both could succeed with different passwords, or the slower
//      one deleted the login the faster one had just made. The second is refused before
//      it creates or deletes anything.
// The invitation is marked accepted (and its token hash cleared) last; failing that is
// logged, not fatal: the account works, and the leftover token is inert because the
// stamp the stale-user branch needs is gone.

import { createHandler, HttpError, type RequestContext } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { isExpired, type InvitationRow } from '../validate-portal-invite/handler.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { isInviteToken, passwordProblem } from '../_shared/portal-account.ts';

export type { InvitationRow } from '../validate-portal-invite/handler.ts';

export type CreateUserResult = { userId: string } | { alreadyRegistered: true };

export interface AcceptInviteDeps {
  allowedOrigins: string[];
  rateLimit(ctx: RequestContext): Promise<RateLimitOutcome>;
  findInvitation(tokenHash: string): Promise<InvitationRow | null>;
  markExpired(invitationId: string): Promise<void>;
  /** increment_invitation_attempt: the new count, or null at the cap. */
  countAttempt(invitationId: string): Promise<number | null>;
  /** A banned user stamped with the invitation id. Any failure but "already registered" throws. */
  createBannedUser(input: { email: string; password: string; displayName: string; invitationId: string }): Promise<CreateUserResult>;
  findUserIdByEmail(email: string): Promise<string | null>;
  /** claim_portal_invitation: whether `claim` now holds the invitation for this acceptance. */
  claim(invitationId: string, claim: string): Promise<boolean>;
  /** release_portal_invitation_claim. */
  releaseClaim(invitationId: string, claim: string): Promise<void>;
  /**
   * delete_stale_portal_user: delete the user an unfinished acceptance of this invitation
   * left, deciding and deleting in one statement; whether it was deleted.
   */
  deleteStaleUser(userId: string, invitationId: string, claim: string): Promise<boolean>;
  /** A new claim id. */
  newClaim?: () => string;
  /** The user this acceptance created, on rollback. */
  deleteUser(userId: string): Promise<void>;
  banUser(userId: string): Promise<void>;
  /** link_portal_invitation: the linked account id, or null when nothing could take the link. */
  link(invitationId: string, userId: string): Promise<string | null>;
  /** Lift the ban and clear pending_invite, in one call. */
  activateUser(userId: string): Promise<void>;
  markAccepted(invitationId: string): Promise<void>;
  logAccepted(entry: { contactId: string; userId: string; invitationId: string; ip: string | null; userAgent: string | null }): Promise<void>;
  /** Tell the owner the account is ready. Never throws past the caller's catch. */
  notifyOwner(entry: { contactId: string; invitationId: string; email: string; displayName: string }): Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

const MAX_ATTEMPTS_MESSAGE = 'Too many attempts with this invitation. Ask for a new one.';
const COULD_NOT_ACTIVATE = 'Your account could not be set up. Try again, or ask for a new invitation.';

function refuse(status: number, error: string, code: string): never {
  throw new HttpError(status, error, code);
}

/** CR, LF and NUL out of a display name before it reaches the sign-in user's metadata. */
export function cleanDisplayName(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/\0/g, '').trim();
}

export function createAcceptInviteHandler(deps: AcceptInviteDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'accept-portal-invite',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit,
    maxBodyBytes: 8000,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const input = (body ?? {}) as { token?: unknown; password?: unknown; display_name?: unknown };
      if (!isInviteToken(input.token) || typeof input.password !== 'string') {
        refuse(400, 'This invitation link is not valid.', 'invalid_invitation');
      }
      const token = input.token;
      const password = input.password;
      const problem = passwordProblem(password);
      if (problem) refuse(400, problem, 'weak_password');
      if (input.display_name !== undefined && input.display_name !== null && (typeof input.display_name !== 'string' || input.display_name.length > 100)) {
        refuse(400, 'Use a name of at most 100 characters.', 'invalid_name');
      }
      const displayName = typeof input.display_name === 'string' ? cleanDisplayName(input.display_name) : '';

      const invitation = await deps.findInvitation(await sha256Hex(token));
      if (!invitation) refuse(400, 'This invitation link is not valid.', 'invalid_invitation');
      if (invitation.status === 'accepted') refuse(400, 'This invitation has already been used.', 'used');
      if (invitation.status !== 'pending') refuse(400, 'This invitation no longer works.', invitation.status);
      if (isExpired(invitation, now())) {
        try {
          await deps.markExpired(invitation.id);
        } catch (err) {
          log.error('could not mark the invitation expired', err);
        }
        refuse(400, 'This invitation has expired.', 'expired');
      }

      const claim = (deps.newClaim ?? (() => crypto.randomUUID()))();
      if (!(await deps.claim(invitation.id, claim))) {
        refuse(409, 'This invitation is being used right now. Wait a moment, then try again.', 'in_progress');
      }
      const accept = async (): Promise<Response> => {
        if ((await deps.countAttempt(invitation.id)) === null) refuse(429, MAX_ATTEMPTS_MESSAGE, 'too_many_attempts');

        const createInput = { email: invitation.email, password, displayName, invitationId: invitation.id };
        let created = await deps.createBannedUser(createInput);
        if ('alreadyRegistered' in created) {
          const staleId = await deps.findUserIdByEmail(invitation.email);
          if (staleId) {
            if (await deps.deleteStaleUser(staleId, invitation.id, claim)) {
              created = await deps.createBannedUser(createInput);
            } else {
              log.warn('address already registered to a user this invitation did not create; refusing to replace it');
            }
          }
        }
        if ('alreadyRegistered' in created) {
          refuse(409, 'An account with this email already exists. Sign in instead, or ask for help.', 'already_registered');
        }
        const userId = created.userId;

        let accountId: string | null = null;
        try {
          accountId = await deps.link(invitation.id, userId);
        } catch (err) {
          log.error('link failed', err);
        }
        if (!accountId) {
          // Second latch: the user was created banned and never un-banned, so it cannot sign
          // in. Ban again anyway (it holds even if the delete below fails), then delete.
          try {
            await deps.banUser(userId);
          } catch (err) {
            log.error('rollback ban failed', err);
          }
          try {
            await deps.deleteUser(userId);
          } catch (err) {
            log.error('rollback delete failed', err);
          }
          refuse(409, COULD_NOT_ACTIVATE, 'not_linked');
        }

        try {
          await deps.activateUser(userId);
        } catch (err) {
          // Linked but still banned: locked out of an account that exists, the safe way round.
          log.error('could not lift the ban after linking', err);
          refuse(409, COULD_NOT_ACTIVATE, 'not_activated');
        }

        try {
          await deps.markAccepted(invitation.id);
        } catch (err) {
          log.error('could not mark the invitation accepted; its token is inert without the stamp', err);
        }
        try {
          await deps.logAccepted({ contactId: invitation.contact_id, userId, invitationId: invitation.id, ip, userAgent });
        } catch (err) {
          log.error('could not record the acceptance', err);
        }
        try {
          await deps.notifyOwner({ contactId: invitation.contact_id, invitationId: invitation.id, email: invitation.email, displayName });
        } catch (err) {
          log.error('could not notify the owner', err);
        }
        return json(200, { success: true, email: invitation.email });
      };

      try {
        return await accept();
      } finally {
        try {
          await deps.releaseClaim(invitation.id, claim);
        } catch (err) {
          log.error('could not release the acceptance claim; it lapses in five minutes', err);
        }
      }
    },
  });
}
