// validate-portal-invite: what the invitation page asks before it shows the set-password
// form. Public: the token in the link is the only credential, so the caller's address is
// rate limited (then a shared ceiling) before the body is read.
//
// It answers whether the link still works and, when it does, the name and address the
// account will carry. Nothing else: no phone, no contact id. A redeemed invitation has
// its token hash cleared, so a reopened link reads as unknown, not as used; the page's
// copy covers both.

import { createHandler, type RequestContext } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { isInviteToken } from '../_shared/portal-account.ts';

export interface InvitationRow {
  id: string;
  contact_id: string;
  email: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expires_at: string;
}

export interface InviteeContact {
  first_name: string | null;
  last_name: string | null;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_email: string | null;
}

export interface ValidateInviteDeps {
  allowedOrigins: string[];
  rateLimit(ctx: RequestContext): Promise<RateLimitOutcome>;
  findInvitation(tokenHash: string): Promise<InvitationRow | null>;
  markExpired(invitationId: string): Promise<void>;
  loadContact(contactId: string): Promise<InviteeContact | null>;
  now?: () => Date;
  logSink?: LogSink;
}

export type InviteState = 'not_found' | 'used' | 'revoked' | 'expired';

/** Whether a pending invitation's time is up. */
export function isExpired(row: Pick<InvitationRow, 'expires_at'>, now: Date): boolean {
  const at = Date.parse(row.expires_at);
  return !Number.isFinite(at) || at <= now.getTime();
}

/** The name an invitation greets: the spouse's when the link went to the spouse's address. */
export function inviteeName(contact: InviteeContact, email: string): { first_name: string | null; last_name: string | null } {
  const toSpouse = !!contact.spouse_email && contact.spouse_email.trim().toLowerCase() === email.trim().toLowerCase();
  return toSpouse
    ? { first_name: contact.spouse_first_name ?? contact.first_name, last_name: contact.spouse_last_name ?? contact.last_name }
    : { first_name: contact.first_name, last_name: contact.last_name };
}

export function createValidateInviteHandler(deps: ValidateInviteDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'validate-portal-invite',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit,
    maxBodyBytes: 4000,
    logSink: deps.logSink,
    async handle({ body, json, log }) {
      const invalid = (reason: InviteState) => json(200, { valid: false, reason });
      const token = (body as { token?: unknown } | null)?.token;
      if (!isInviteToken(token)) return invalid('not_found');

      const invitation = await deps.findInvitation(await sha256Hex(token));
      if (!invitation) return invalid('not_found');
      if (invitation.status === 'accepted') return invalid('used');
      if (invitation.status === 'revoked') return invalid('revoked');
      if (invitation.status === 'expired') return invalid('expired');
      if (isExpired(invitation, now())) {
        try {
          await deps.markExpired(invitation.id);
        } catch (err) {
          log.error('could not mark the invitation expired', err);
        }
        return invalid('expired');
      }

      const contact = await deps.loadContact(invitation.contact_id);
      if (!contact) return invalid('not_found');
      return json(200, { valid: true, contact: { ...inviteeName(contact, invitation.email), email: invitation.email } });
    },
  });
}
