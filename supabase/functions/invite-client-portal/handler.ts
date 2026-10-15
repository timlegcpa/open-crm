// invite-client-portal: the owner invites one of a contact's addresses (the primary or
// the spouse's, any row of contact_emails) to the client portal. Owner only.
//
// create_portal_invitation (0012) writes the account and the invitation in one
// transaction, compares addresses case-insensitively through the open-account index, and
// holds the three-a-day cap per contact; its refusals map to 409 and 429 here. The raw
// token exists only in this request: the database keeps its SHA-256, the email carries
// the link, and the response hands the link back to the owner's screen, which is how the
// owner delivers it when no email provider is configured.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import type { SendResult } from '../_shared/outbound.ts';
import { randomTokenBase64Url, sha256Hex } from '../_shared/crypto.ts';
import { inviteExpiry, inviteUrl, type InviteVariant } from './invite-email.ts';

export interface InviteContact {
  id: string;
  first_name: string | null;
  spouse_first_name: string | null;
  email: string | null;
}

export interface ContactEmailRow {
  email: string;
  kind: 'primary' | 'spouse';
}

export interface SendInviteInput {
  to: string;
  firstName: string | null;
  url: string;
  expiresAt: Date;
  variant: InviteVariant;
  invitationId: string;
}

export interface InviteAuditEntry {
  ownerId: string;
  action: 'portal_invite_sent' | 'portal_invite_resent';
  details: Record<string, string | boolean>;
  ip: string | null;
  userAgent: string | null;
}

export interface InviteDeps {
  allowedOrigins: string[];
  /** SITE_URL: the links in emails point here. */
  siteUrl: string | null;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  loadContact(contactId: string): Promise<InviteContact | null>;
  contactEmails(contactId: string): Promise<ContactEmailRow[]>;
  /** create_portal_invitation: the invitation id. Throws the database error untranslated. */
  createInvitation(input: { contactId: string; email: string; tokenHash: string; expiresAt: Date; invitedBy: string }): Promise<string>;
  sendInvite(input: SendInviteInput): Promise<SendResult>;
  audit(entry: InviteAuditEntry): Promise<void>;
  now?: () => Date;
  logSink?: LogSink;
}

/** A database refusal from the invite functions, as the owner should read it. Null for anything else. */
export function inviteRefusal(err: unknown): HttpError | null {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const message = String(e.message ?? '');
  if (e.code === '23505') return new HttpError(409, 'This address already has a portal account or an open invitation.', 'already_invited');
  if (message.includes('contact_delete_in_progress')) return new HttpError(409, 'This contact is being deleted.', 'delete_in_progress');
  if (message.includes('portal_account_staff_user')) return new HttpError(409, 'That sign-in belongs to the owner.', 'staff_user');
  if (message.includes('portal_invite_throttled')) return new HttpError(429, 'Three invitations went to this contact in the last day. Try again tomorrow.', 'invite_throttled');
  if (message.includes('portal_invite_email_not_on_contact')) return new HttpError(400, 'That address is not one of this contact\'s.', 'email_not_on_contact');
  if (message.includes('portal_account_not_found')) return new HttpError(404, 'That portal account no longer exists.', 'not_found');
  if (message.includes('portal_account_not_reinvitable')) return new HttpError(409, 'That account is active. Deactivate it before inviting again.', 'not_reinvitable');
  if (message.includes('portal_account_has_login')) return new HttpError(409, 'That account still has a sign-in. Try again.', 'has_login');
  if (message.includes('contact_not_found')) return new HttpError(404, 'That contact no longer exists.', 'not_found');
  return null;
}

/** A fresh link: the raw token for the URL, its hash for the database. */
export async function newInviteToken(): Promise<{ raw: string; hash: string }> {
  const raw = randomTokenBase64Url();
  return { raw, hash: await sha256Hex(raw) };
}

const badRequest = () => new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);

export function createInviteHandler(deps: InviteDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'invite-client-portal',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 2048,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const input = (body ?? {}) as { contact_id?: unknown; email?: unknown };
      if (!isUuid(input.contact_id)) throw badRequest();
      if (input.email !== undefined && (typeof input.email !== 'string' || input.email.length > 320)) throw badRequest();
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; an invitation link cannot be built');
        throw new HttpError(500, 'Invitations are not set up on this server yet (SITE_URL).', 'site_url_missing');
      }

      const contact = await deps.loadContact(input.contact_id);
      if (!contact) throw new HttpError(404, 'That contact no longer exists.', 'not_found');

      // The address must be one of the contact's own rows; its kind picks the greeting.
      const rows = await deps.contactEmails(contact.id);
      const wanted = (typeof input.email === 'string' ? input.email : contact.email ?? '').trim().toLowerCase();
      if (!wanted) throw new HttpError(400, 'This contact has no email address.', 'no_email');
      const row = rows.find((r) => r.email.trim().toLowerCase() === wanted);
      if (!row) throw new HttpError(400, "That address is not one of this contact's.", 'email_not_on_contact');
      const firstName = row.kind === 'spouse' ? contact.spouse_first_name ?? contact.first_name : contact.first_name;

      const token = await newInviteToken();
      const expiresAt = inviteExpiry(now());
      let invitationId: string;
      try {
        invitationId = await deps.createInvitation({
          contactId: contact.id,
          email: row.email.trim(),
          tokenHash: token.hash,
          expiresAt,
          invitedBy: principal.userId,
        });
      } catch (err) {
        const refusal = inviteRefusal(err);
        if (refusal) throw refusal;
        throw err;
      }

      const url = inviteUrl(deps.siteUrl, token.raw);
      const delivery = await sendSafely(deps, log, {
        to: row.email.trim(),
        firstName,
        url,
        expiresAt,
        variant: 'initial',
        invitationId,
      });

      try {
        await deps.audit({
          ownerId: principal.userId,
          action: 'portal_invite_sent',
          details: { contact_id: contact.id, invitation_id: invitationId, email_kind: row.kind, delivery },
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

/**
 * Send, and turn every outcome into sent / failed / unknown. A send that throws (no
 * provider configured in production) is a failure the owner sees, never a 500: the
 * invitation exists and its link is on the owner's screen.
 */
export async function sendSafely(
  deps: Pick<InviteDeps, 'sendInvite'>,
  log: { error(message: string, err?: unknown): void },
  input: SendInviteInput,
): Promise<'sent' | 'failed' | 'unknown'> {
  try {
    const result = await deps.sendInvite(input);
    return result.status;
  } catch (err) {
    log.error('invitation email could not be sent', err);
    return 'failed';
  }
}
