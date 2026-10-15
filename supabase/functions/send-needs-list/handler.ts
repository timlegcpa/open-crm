// send-needs-list: send a draft request to its contact, or remind them about a sent one.
//
// Owner only over HTTP. The AI connector (mcp-crm) never calls this endpoint: it runs the
// same send and reminder in its own process, through the exported sendList and remindList
// below, with the content version and address its review token was checked against
// (Reviewed). So there is no second credential this endpoint accepts and nothing a
// browser could present to reach the connector's path. resolveActor stays the seam for
// who acted.
//
// Sending, in order, each step before anything becomes visible to the client:
//   1. The list is a draft with at least one item, and its contact has an address.
//   2. Where the email points: the portal when the contact has an active portal account,
//      else a start link (a one-time token, 14 days) that creates the sign-in first. The
//      link is issued only for the contact and address read in step 1, re-checked under
//      the list's lock (a reassigned list or a corrected address gets none). The first
//      send never supersedes an earlier link: a send that lost the publish race would
//      otherwise kill the winner's.
//   3. Publish, only at the content version read in step 1 (needs_send_list, a
//      compare-and-swap) and only while the list still goes to the contact and address
//      read in step 1 (checked under the publish's row lock): an edit or an address
//      correction landing in between publishes and emails nothing.
//   4. The email. Its failure does not undo the send (the client sees the request in the
//      portal, and Remind retries); the answer says whether it went: email_sent true,
//      false, or null when the provider's answer was lost.
//
// Reminding: the list is sent and has open items. A manual reminder ignores the pause and
// the cap (those are the schedule's). One reminder at a time per list: the count is
// claimed first, from the count read (needs_claim_reminder), so of two at once the second
// is refused before it mints or sends anything; the claimed number keys the email. A
// contact still without an active account gets a fresh start link, and only once that
// email was accepted do the list's older links stop working (needs_supersede_start_links:
// never the link just sent, never a newer one). A failed email gives the count back and
// expires its link.

import { createHandler, HttpError, type Principal } from '../_shared/handler.ts';
import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import type { AuditEntry } from '../_shared/audit.ts';
import type { EmailContent } from '../_shared/email-layout.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import type { SendResult } from '../_shared/outbound.ts';
import { isValidEmail } from '../_shared/outbound.ts';
import { randomTokenBase64Url, sha256Hex } from '../_shared/crypto.ts';
import {
  clientFirstName,
  portalRequestUrl,
  requestReminderEmail,
  requestSentEmail,
  startLinkExpiry,
  startLinkUrl,
} from './needs-email.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NeedsListRow {
  id: string;
  contact_id: string;
  title: string;
  intro_message: string | null;
  status: 'draft' | 'sent' | 'submitted' | 'closed';
  content_version: number;
  reminder_count: number;
}

export interface NeedsContactRow {
  first_name: string | null;
  email: string | null;
}

export interface ListProgress {
  actionable: number;
  fulfilled: number;
  required_open: number;
}

export type SendOutcome = 'sent' | 'already_sent' | 'changed' | 'contact_changed' | 'address_changed' | 'gone' | 'not_draft';
export type RecipientCheck = 'ok' | 'gone' | 'contact_changed' | 'address_changed';

/** The database and the mail, as the send and remind paths need them. */
export interface NeedsSendStore {
  loadList(listId: string): Promise<NeedsListRow | null>;
  loadContact(contactId: string): Promise<NeedsContactRow | null>;
  countItems(listId: string): Promise<number>;
  /** needs_list_progress for one list. */
  progress(listId: string): Promise<ListProgress>;
  hasActivePortalAccount(contactId: string): Promise<boolean>;
  /**
   * needs_issue_start_link, for the contact and address the caller read: the new link's
   * id, or why none was issued (the list now belongs to another contact, or the address
   * is no longer the contact's).
   */
  issueStartLink(input: {
    listId: string;
    contactId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    actorId: string | null;
  }): Promise<{ id: string } | { refused: 'contact_changed' | 'address_changed' }>;
  /** expire_start_link, for a link minted for a message that then never went. */
  expireStartLink(linkId: string): Promise<void>;
  /** needs_supersede_start_links: the list's other pending links stop working. */
  supersedeStartLinks(listId: string, keepLinkId: string): Promise<void>;
  /** needs_send_list: publish at the version read, to the contact and address read. */
  sendList(listId: string, expectedVersion: number, recipient: { contactId: string; email: string }): Promise<SendOutcome>;
  /** needs_recipient_current: whether the list still goes to this contact and address. */
  recipientCurrent(listId: string, recipient: { contactId: string; email: string }): Promise<RecipientCheck>;
  /** needs_claim_reminder, from the count the caller read. */
  claimReminder(listId: string, expectedCount: number): Promise<'claimed' | 'in_progress' | 'not_sent'>;
  /** needs_release_reminder: a reminder whose email failed gives its count back. */
  releaseReminder(listId: string, claimedCount: number): Promise<void>;
  loadOrg(): Promise<OrgIdentity>;
  sendEmail(message: { to: string; subject: string; content: EmailContent; fromName: string; idempotencyKey: string }): Promise<SendResult>;
  newToken?: () => string;
  now?: () => Date;
}

export interface SendNeedsDeps extends NeedsSendStore {
  allowedOrigins: string[];
  siteUrl: string | null;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /**
   * Who acted, for created_by and the audit row: the seam the AI connector's door uses.
   * Default: the signed-in owner.
   */
  resolveActor?: (principal: Principal) => string | null;
  audit(entry: AuditEntry): Promise<void>;
  logSink?: LogSink;
}

function refuse(status: number, error: string, code: string): never {
  throw new HttpError(status, error, code);
}

/** Where the email points: the portal, or a fresh start link; null when the list or address moved. */
async function destination(
  store: NeedsSendStore,
  siteUrl: string,
  list: NeedsListRow,
  email: string,
  actorId: string | null,
): Promise<{ url: string; startLinkId: string | null } | null> {
  if (await store.hasActivePortalAccount(list.contact_id)) {
    return { url: portalRequestUrl(siteUrl, list.id), startLinkId: null };
  }
  const token = (store.newToken ?? randomTokenBase64Url)();
  const now = (store.now ?? (() => new Date()))();
  const issued = await store.issueStartLink({
    listId: list.id,
    contactId: list.contact_id,
    email,
    tokenHash: await sha256Hex(token),
    expiresAt: startLinkExpiry(now),
    actorId,
  });
  if ('refused' in issued) return null;
  return { url: startLinkUrl(siteUrl, token), startLinkId: issued.id };
}

/** Expire a link whose message never went; logged, never thrown. */
async function expireQuietly(store: NeedsSendStore, linkId: string | null, log: Logger): Promise<void> {
  if (!linkId) return;
  try {
    await store.expireStartLink(linkId);
  } catch (err) {
    log.error('could not expire an unsent start link', err);
  }
}

const emailStatus = (r: SendResult): boolean | null => (r.status === 'sent' ? true : r.status === 'failed' ? false : null);

/**
 * What the AI connector reviewed before asking for a send or a reminder: the content
 * version its review token was verified over, and the address it read back. Both are
 * re-checked against the rows loaded here, so an edit (or a changed address) landing
 * between the connector's check and this call sends nothing. The owner's own send passes
 * none: the owner is looking at the request in the CRM.
 */
export interface Reviewed {
  version?: number;
  email: string;
  /**
   * A reminder's last check that the request still reads as reviewed, fulfilment
   * included: run after the open count is read and before the count is claimed or any
   * link minted or email sent, so an answer landing after the connector's own check
   * sends nothing.
   */
  recheck?: () => Promise<boolean>;
}

export type RemindResult =
  | { status: 'reminded'; email: 'sent' | 'unknown'; remaining: number; startLink: boolean }
  | { status: 'nothing_open' }
  | { status: 'not_sent' }
  | { status: 'no_email' }
  | { status: 'in_progress' }
  | { status: 'changed' }
  | { status: 'email_failed' };

/**
 * One reminder for one sent list. Shared by the manual reminder and the dispatcher, so
 * both count, link and word it the same way. Never throws for a refusal; a database error
 * propagates.
 */
export async function remindList(
  store: NeedsSendStore,
  siteUrl: string,
  list: NeedsListRow,
  actorId: string | null,
  log: Logger,
  reviewed?: Reviewed,
): Promise<RemindResult> {
  if (list.status !== 'sent') return { status: 'not_sent' };
  if (reviewed?.version !== undefined && reviewed.version !== list.content_version) return { status: 'changed' };
  const progress = await store.progress(list.id);
  const remaining = Math.max(progress.actionable - progress.fulfilled, 0);
  if (remaining === 0) return { status: 'nothing_open' };
  const contact = await store.loadContact(list.contact_id);
  const email = contact?.email?.trim().toLowerCase() ?? '';
  if (!email || !isValidEmail(email)) return { status: 'no_email' };
  if (reviewed && reviewed.email.trim().toLowerCase() !== email) return { status: 'changed' };
  if (reviewed?.recheck && !(await reviewed.recheck())) return { status: 'changed' };

  // Claim this reminder's number before minting or sending anything.
  const number = list.reminder_count;
  const claim = await store.claimReminder(list.id, number);
  if (claim !== 'claimed') return { status: claim };

  const giveBack = async () => {
    try {
      await store.releaseReminder(list.id, number);
    } catch (err) {
      log.error('could not give a reminder count back', err);
    }
  };
  let startLinkId: string | null = null;
  let result: SendResult;
  try {
    const target = await destination(store, siteUrl, list, email, actorId);
    if (!target) {
      await giveBack();
      return { status: 'changed' };
    }
    startLinkId = target.startLinkId;
    // The address may have been corrected while the destination was worked out: never
    // remind an address the contact no longer has.
    if ((await store.recipientCurrent(list.id, { contactId: list.contact_id, email })) !== 'ok') {
      await expireQuietly(store, startLinkId, log);
      await giveBack();
      return { status: 'changed' };
    }
    const org = await store.loadOrg();
    const { subject, content } = requestReminderEmail({
      org, clientName: clientFirstName(contact), title: list.title, remaining, url: target.url, startLink: startLinkId !== null,
    });
    result = await store.sendEmail({
      to: email, subject, content, fromName: org.senderName, idempotencyKey: `needs-remind:${list.id}:${number}`,
    });
  } catch (err) {
    await expireQuietly(store, startLinkId, log);
    await giveBack();
    throw err;
  }
  if (result.status === 'failed') {
    log.warn('reminder not sent', { reason: result.reason });
    await expireQuietly(store, startLinkId, log);
    await giveBack();
    return { status: 'email_failed' };
  }
  // The new link went out (or may have): the older ones stop working now, never before.
  if (startLinkId) {
    try {
      await store.supersedeStartLinks(list.id, startLinkId);
    } catch (err) {
      log.error('could not retire the older start links', err);
    }
  }
  return { status: 'reminded', email: result.status, remaining, startLink: startLinkId !== null };
}

export type SendListResult =
  | { status: 'sent'; email: boolean | null; itemCount: number; startLink: boolean }
  | { status: 'no_items' | 'no_email' | 'changed' | 'already_sent' | 'gone' | 'not_draft' };

/**
 * Publish one draft and email its contact. Shared by the owner's send and the AI
 * connector's, so both check, link, publish and word it the same way. A list or address
 * that moved (contact_changed, address_changed, a lost version race, a refused link) is
 * one result, 'changed': nothing was published. A refusal is a result; a database error
 * propagates. Writes no audit row: each caller records its own.
 */
export async function sendList(
  store: NeedsSendStore,
  siteUrl: string,
  list: NeedsListRow,
  actorId: string | null,
  log: Logger,
  reviewed?: Reviewed,
): Promise<SendListResult> {
  if (list.status !== 'draft') return { status: 'already_sent' };
  // The connector's version is checked before anything is minted, and it is the version
  // the publish below compares against.
  if (reviewed?.version !== undefined && reviewed.version !== list.content_version) return { status: 'changed' };
  const itemCount = await store.countItems(list.id);
  if (itemCount === 0) return { status: 'no_items' };
  const contact = await store.loadContact(list.contact_id);
  const email = contact?.email?.trim().toLowerCase() ?? '';
  if (!email || !isValidEmail(email)) return { status: 'no_email' };
  if (reviewed && reviewed.email.trim().toLowerCase() !== email) return { status: 'changed' };

  const target = await destination(store, siteUrl, list, email, actorId);
  if (!target) return { status: 'changed' };
  const { url, startLinkId } = target;
  const outcome = await store.sendList(list.id, reviewed?.version ?? list.content_version, { contactId: list.contact_id, email });
  if (outcome !== 'sent') {
    // Nothing was published by this call, so its link is never emailed: retire it.
    await expireQuietly(store, startLinkId, log);
    if (outcome === 'already_sent' || outcome === 'gone' || outcome === 'not_draft') return { status: outcome };
    // changed, contact_changed, address_changed, or a refusal this code does not know yet.
    return { status: 'changed' };
  }

  let emailSent: boolean | null = false;
  try {
    const org = await store.loadOrg();
    const { subject, content } = requestSentEmail({
      org, clientName: clientFirstName(contact), title: list.title, itemCount, intro: list.intro_message, url,
      startLink: startLinkId !== null,
    });
    const result = await store.sendEmail({ to: email, subject, content, fromName: org.senderName, idempotencyKey: `needs-send:${list.id}` });
    emailSent = emailStatus(result);
    if (result.status === 'failed') log.warn('request email not sent', { reason: result.reason });
  } catch (err) {
    log.error('request email failed', err);
  }
  return { status: 'sent', email: emailSent, itemCount, startLink: startLinkId !== null };
}

export function createSendNeedsListHandler(deps: SendNeedsDeps): (req: Request) => Promise<Response> {
  const resolveActor = deps.resolveActor ?? ((p: Principal) => (p.kind === 'owner' ? p.userId : null));
  return createHandler({
    name: 'send-needs-list',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ body, json, log, principal, ip, userAgent }) {
      const input = (body ?? {}) as { list_id?: unknown; remind?: unknown };
      if (typeof input.list_id !== 'string' || !UUID.test(input.list_id)) refuse(400, 'Choose a request.', 'invalid_list');
      if (input.remind !== undefined && typeof input.remind !== 'boolean') refuse(400, 'Bad request.', 'bad_request');
      // A link in an email needs the site's address; never guess one.
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set');
        refuse(500, 'Sending is not set up yet.', 'site_url_missing');
      }
      const siteUrl = deps.siteUrl;
      const actorId = resolveActor(principal);
      const list = await deps.loadList(input.list_id);
      if (!list) refuse(404, 'This request no longer exists.', 'not_found');

      if (input.remind === true) {
        const result = await remindList(deps, siteUrl, list, actorId, log);
        if (result.status === 'not_sent') refuse(409, 'Only a sent request can be reminded.', 'not_sent');
        if (result.status === 'nothing_open') refuse(409, 'Every item is already answered.', 'nothing_open');
        if (result.status === 'no_email') refuse(400, 'This contact has no email address.', 'no_email');
        if (result.status === 'in_progress') refuse(409, 'A reminder for this request is already being sent.', 'reminder_in_progress');
        if (result.status === 'changed') refuse(409, 'The contact changed while reminding. Refresh, then try again.', 'changed');
        if (result.status === 'email_failed') refuse(502, 'The reminder could not be sent. Try again.', 'email_failed');
        await writeAudit(deps, log, {
          actorId, action: 'needs_list_reminded', ip, userAgent,
          details: { list_id: list.id, contact_id: list.contact_id, remaining: result.remaining, start_link: result.startLink, email_status: result.email },
        });
        return json(200, { status: 'reminded', email_sent: result.email === 'sent' ? true : null, remaining: result.remaining });
      }

      const sent = await sendList(deps, siteUrl, list, actorId, log);
      if (sent.status === 'already_sent') refuse(409, 'This request was already sent.', 'already_sent');
      if (sent.status === 'no_items') refuse(400, 'Add at least one item before sending.', 'no_items');
      if (sent.status === 'no_email') refuse(400, 'This contact has no email address.', 'no_email');
      if (sent.status === 'changed') refuse(409, 'The request changed while sending. Review it, then send again.', 'changed');
      if (sent.status === 'gone') refuse(404, 'This request no longer exists.', 'not_found');
      if (sent.status !== 'sent') refuse(409, 'This request can no longer be sent.', 'not_draft');

      await writeAudit(deps, log, {
        actorId, action: 'needs_list_sent', ip, userAgent,
        details: {
          list_id: list.id, contact_id: list.contact_id, item_count: sent.itemCount, start_link: sent.startLink,
          email_status: sent.email === true ? 'sent' : sent.email === false ? 'failed' : 'unknown',
        },
      });
      return json(200, { status: 'sent', email_sent: sent.email, start_link: sent.startLink });
    },
  });
}

/** The audit row follows the action; failing to write it is logged, never undoes a send. */
async function writeAudit(deps: SendNeedsDeps, log: Logger, entry: AuditEntry): Promise<void> {
  try {
    await deps.audit(entry);
  } catch (err) {
    log.error('audit write failed', err);
  }
}
