// resend-portal-invite: a fresh link for ONE portal account (Resend for an invited
// account, Re-invite for a deactivated one). Owner only.
//
// One account, never the contact: a resend that worked contact-wide once revoked a
// spouse's pending link and set a spouse's active account back to invited, which locked
// them out. reissue_portal_invitation (0012) revokes only this account's address's
// pending links and resets only this row.
//
// The cap is checked FIRST, before anything destructive: a deactivated account's banned
// sign-in user is deleted before the reissue (otherwise the new acceptance would collide
// with it), and a limit that refused after that delete would leave the person with no
// way in at all. The reissue checks the cap again atomically.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import {
  inviteRefusal,
  newInviteToken,
  sendSafely,
  type InviteAuditEntry,
  type SendInviteInput,
} from '../invite-client-portal/handler.ts';
import { inviteExpiry, inviteUrl } from '../invite-client-portal/invite-email.ts';
import type { SendResult } from '../_shared/outbound.ts';

export interface PortalAccountRow {
  id: string;
  contact_id: string;
  user_id: string | null;
  status: 'invited' | 'active' | 'suspended' | 'deactivated';
  invited_email: string | null;
}

export interface Greeting {
  first_name: string | null;
  spouse_first_name: string | null;
  spouse_email: string | null;
}

export interface ResendDeps {
  allowedOrigins: string[];
  siteUrl: string | null;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  loadAccount(accountId: string): Promise<PortalAccountRow | null>;
  throttled(contactId: string): Promise<boolean>;
  /** Delete a sign-in user; an already-missing one is fine. */
  deleteAuthUser(userId: string): Promise<void>;
  reissue(input: { accountId: string; tokenHash: string; expiresAt: Date; invitedBy: string }): Promise<{ invitationId: string; contactId: string; email: string }>;
  loadGreeting(contactId: string): Promise<Greeting | null>;
  sendInvite(input: SendInviteInput): Promise<SendResult>;
  audit(entry: InviteAuditEntry): Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

export function createResendHandler(deps: ResendDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'resend-portal-invite',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const accountId = (body as { account_id?: unknown } | null)?.account_id;
      if (!isUuid(accountId)) throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; an invitation link cannot be built');
        throw new HttpError(500, 'Invitations are not set up on this server yet (SITE_URL).', 'site_url_missing');
      }

      const account = await deps.loadAccount(accountId);
      if (!account) throw new HttpError(404, 'That portal account no longer exists.', 'not_found');
      if (account.status !== 'invited' && account.status !== 'deactivated') {
        throw new HttpError(409, 'That account is active. Deactivate it before inviting again.', 'not_reinvitable');
      }
      if (await deps.throttled(account.contact_id)) {
        throw new HttpError(429, 'Three invitations went to this contact in the last day. Try again tomorrow.', 'invite_throttled');
      }

      if (account.user_id) await deps.deleteAuthUser(account.user_id);

      const token = await newInviteToken();
      const expiresAt = inviteExpiry(now());
      let issued: { invitationId: string; contactId: string; email: string };
      try {
        issued = await deps.reissue({ accountId, tokenHash: token.hash, expiresAt, invitedBy: principal.userId });
      } catch (err) {
        const refusal = inviteRefusal(err);
        if (refusal) throw refusal;
        throw err;
      }

      const greeting = await deps.loadGreeting(issued.contactId);
      const toSpouse = !!greeting?.spouse_email && greeting.spouse_email.trim().toLowerCase() === issued.email.trim().toLowerCase();
      const firstName = toSpouse ? greeting?.spouse_first_name ?? greeting?.first_name ?? null : greeting?.first_name ?? null;
      const url = inviteUrl(deps.siteUrl, token.raw);
      const delivery = await sendSafely(deps, log, {
        to: issued.email,
        firstName,
        url,
        expiresAt,
        variant: 'resend',
        invitationId: issued.invitationId,
      });

      try {
        await deps.audit({
          ownerId: principal.userId,
          action: 'portal_invite_resent',
          details: { contact_id: issued.contactId, account_id: accountId, invitation_id: issued.invitationId, delivery },
          ip,
          userAgent,
        });
      } catch (err) {
        log.error('audit failed', err);
      }
      return json(200, { success: true, inviteUrl: url, emailSent: delivery === 'sent', delivery });
    },
  });
}
