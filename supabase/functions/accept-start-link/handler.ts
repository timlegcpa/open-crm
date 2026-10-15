// accept-start-link: redeem the start link in a request email. A contact with no portal
// account chooses a password; the server creates their sign-in user, links it to a portal
// account for that contact, retires the link, and the page then signs in.
//
// Public: the token is the credential. The caller's address is rate limited (then a shared
// ceiling) before the body is read. The latches, in order (the same protocol as
// accept-portal-invite, each of which once failed in the source system):
//   1. One redemption at a time (claim_start_link, held to the end, released in finally).
//      Two at once once both answered success with different passwords, or the slower
//      deleted the login the faster had just made.
//   2. The user is CREATED banned and stamped app_metadata.pending_signup = this link's
//      id, and un-banned (with the stamp cleared, in one call) only after the link lands.
//   3. An address already registered is replaced ONLY when that user is still banned and
//      stamped by a start link and is an abandoned attempt (delete_stale_start_link_user,
//      which decides and deletes in one statement). A contact match alone once let a
//      replayed token replace a live login's password.
//   4. The link (link_start_link) re-checks, in its own transaction, that the link is
//      still pending, unexpired, claimed by this call, and that access was not revoked.
//      If it refuses or fails, the new user is banned again and deleted.
//   5. The link is retired last (consumed, and its hash overwritten so the emailed token
//      stops resolving), with the contact's pending invitations to the same address
//      revoked. Retiring is retried once and fails closed: a live credential is not
//      something to leave behind quietly.

import { createHandler, HttpError, type RequestContext } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { isInviteToken, passwordProblem } from '../_shared/portal-account.ts';

export interface StartLinkRow {
  id: string;
  email: string;
  contact_id: string | null;
  needs_list_id: string | null;
  status: 'pending' | 'consumed' | 'expired' | 'superseded';
  expires_at: string;
  access_revoked: boolean;
}

export type CreateUserResult = { userId: string } | { alreadyRegistered: true };

export interface AcceptStartLinkDeps {
  allowedOrigins: string[];
  rateLimit(ctx: RequestContext): Promise<RateLimitOutcome>;
  /** start_link_lookup. */
  lookup(tokenHash: string): Promise<StartLinkRow | null>;
  /** expire_start_link. */
  expire(linkId: string): Promise<void>;
  claim(linkId: string, claim: string): Promise<boolean>;
  releaseClaim(linkId: string, claim: string): Promise<void>;
  /** A banned user stamped with the link id. Any failure but "already registered" throws. */
  createBannedUser(input: { email: string; password: string; linkId: string }): Promise<CreateUserResult>;
  findUserIdByEmail(email: string): Promise<string | null>;
  deleteStaleUser(userId: string, linkId: string, claim: string): Promise<boolean>;
  banUser(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  /** link_start_link: the account id, or null when the link cannot be redeemed any more. Throws on a conflict. */
  link(linkId: string, userId: string, claim: string): Promise<string | null>;
  /** Lift the ban and clear pending_signup, in one call. */
  activateUser(userId: string): Promise<void>;
  /** retire_start_link: the revoked invitation ids. */
  retire(linkId: string): Promise<string[]>;
  logConsumed(entry: { contactId: string; userId: string; linkId: string; revokedInvites: number; ip: string | null; userAgent: string | null }): Promise<void>;
  /** Tell the owner. Never throws past the caller's catch. */
  notifyOwner(entry: { contactId: string; linkId: string; email: string }): Promise<void>;
  newClaim?: () => string;
  now?: () => Date;
  logSink?: LogSink;
}

const INVALID = 'This link is not valid. Use the link in your most recent email.';
const NO_LONGER = 'This link no longer works. Ask for a new one.';
const COULD_NOT_SET_UP = 'Your account could not be set up. Try again, or ask for a new link.';

function refuse(status: number, error: string, code: string): never {
  throw new HttpError(status, error, code);
}

export function createAcceptStartLinkHandler(deps: AcceptStartLinkDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'accept-start-link',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit,
    maxBodyBytes: 8000,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const input = (body ?? {}) as { token?: unknown; password?: unknown; confirm_password?: unknown };
      if (!isInviteToken(input.token) || typeof input.password !== 'string') refuse(400, INVALID, 'invalid_link');
      const password = input.password;
      if (input.confirm_password !== undefined && input.confirm_password !== password) {
        refuse(400, 'The passwords do not match.', 'password_mismatch');
      }
      const problem = passwordProblem(password);
      if (problem) refuse(400, problem, 'weak_password');

      const link = await deps.lookup(await sha256Hex(input.token));
      if (!link) refuse(404, INVALID, 'invalid_link');
      if (link.status === 'consumed') refuse(410, 'This link was already used. Sign in instead.', 'link_used');
      if (link.status !== 'pending') refuse(410, NO_LONGER, 'link_expired');
      const expired = !(new Date(link.expires_at).getTime() > now().getTime());
      if (expired || link.access_revoked || !link.contact_id) {
        try {
          await deps.expire(link.id);
        } catch (err) {
          log.error('could not mark the start link expired', err);
        }
        refuse(410, NO_LONGER, 'link_expired');
      }
      const contactId = link.contact_id;

      const claim = (deps.newClaim ?? (() => crypto.randomUUID()))();
      if (!(await deps.claim(link.id, claim))) {
        refuse(409, 'This link is being used right now. Wait a moment, then try again.', 'in_progress');
      }

      const redeem = async (): Promise<Response> => {
        const createInput = { email: link.email, password, linkId: link.id };
        let created = await deps.createBannedUser(createInput);
        if ('alreadyRegistered' in created) {
          const staleId = await deps.findUserIdByEmail(link.email);
          if (staleId && (await deps.deleteStaleUser(staleId, link.id, claim))) {
            created = await deps.createBannedUser(createInput);
          } else {
            log.warn('address already registered to a user this link did not create; refusing to replace it');
          }
        }
        if ('alreadyRegistered' in created) {
          refuse(409, 'An account with this email already exists. Sign in instead.', 'already_registered');
        }
        const userId = created.userId;

        let accountId: string | null = null;
        try {
          accountId = await deps.link(link.id, userId, claim);
        } catch (err) {
          log.error('link failed', err);
        }
        if (!accountId) {
          // The user was created banned and never un-banned: ban again anyway (it holds if
          // the delete fails), then delete.
          let removed = true;
          try {
            await deps.banUser(userId);
          } catch (err) {
            log.error('rollback ban failed', err);
          }
          try {
            await deps.deleteUser(userId);
          } catch (err) {
            removed = false;
            log.error('rollback delete failed; a banned sign-in user is left behind', err);
          }
          if (!removed) refuse(500, COULD_NOT_SET_UP, 'orphan_login');
          refuse(409, COULD_NOT_SET_UP, 'portal_account_unavailable');
        }

        try {
          await deps.activateUser(userId);
        } catch (err) {
          // Linked but still banned: locked out of an account that exists, the safe way round.
          log.error('could not lift the ban after linking', err);
          refuse(500, COULD_NOT_SET_UP, 'account_locked');
        }

        let revoked: string[] | null = null;
        for (let attempt = 0; attempt < 2 && revoked === null; attempt++) {
          try {
            revoked = await deps.retire(link.id);
          } catch (err) {
            log.error('could not retire the start link', err, { attempt });
          }
        }
        if (revoked === null) refuse(500, 'Your account was created, but this link could not be closed. Sign in to continue.', 'retire_failed');

        try {
          await deps.logConsumed({ contactId, userId, linkId: link.id, revokedInvites: revoked.length, ip, userAgent });
        } catch (err) {
          log.error('could not record the redemption', err);
        }
        try {
          await deps.notifyOwner({ contactId, linkId: link.id, email: link.email });
        } catch (err) {
          log.error('could not notify the owner', err);
        }
        return json(200, { success: true, email: link.email, contact_id: contactId, needs_list_id: link.needs_list_id });
      };

      try {
        return await redeem();
      } finally {
        try {
          await deps.releaseClaim(link.id, claim);
        } catch (err) {
          log.error('could not release the redemption claim; it lapses in five minutes', err);
        }
      }
    },
  });
}
