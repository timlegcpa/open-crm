// needs-save: every change a client makes to a request, and the only door for them (the
// needs_* tables have no client write policy; see 0005_requests.sql).
//
// Client only, and never from View as client (clientWrites). Each action is one guarded
// database function scoped to the caller's own contact, so an id from another contact, a
// draft, a closed or submitted list, or an accepted item all read as "not here" and
// change nothing:
//   save_contact   confirm or correct the contact's own details (names and phone, never
//                  an email address: any account on the contact, a spouse's included,
//                  could otherwise redirect where the contact signs in and is written to),
//                  when the request asks
//   save_answer    a question's answer; a sensitive one is encrypted here first
//                  (PII_ENCRYPTION_KEY) and stored only as ciphertext, and without the
//                  key the save is refused rather than stored in the clear
//   mark_item      tick or untick a to-do
//   link_document  attach a file the client just uploaded to a document item; the owner
//                  hears about uploads at most once per list per 30 minutes, with no names
//   submit         hand the list back, only when every required item is answered; the
//                  owner and the client each get one email, and a second submit none
//
// Error bodies name the problem for the client, never a row, a column or an answer.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { AuthOutcome, ClientPrincipal } from '../_shared/auth.ts';
import type { EmailContent } from '../_shared/email-layout.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import { isValidEmail, type SendResult } from '../_shared/outbound.ts';
import { encryptPii, toByteaHex } from '../_shared/crypto.ts';
import {
  clientDisplayName,
  clientFirstName,
  ownerDocumentsUrl,
  ownerRequestsUrl,
  requestSubmittedClientEmail,
  requestSubmittedOwnerEmail,
  requestUploadOwnerEmail,
} from '../send-needs-list/needs-email.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest answer a question takes, in characters (the column's own limit). */
export const ANSWER_MAX = 5000;

/**
 * The contact fields a request may ask the client to confirm, and their longest values.
 * No email address: changing one is the owner's (see the header).
 */
export const CONTACT_FIELDS = {
  first_name: 200,
  last_name: 200,
  phone: 40,
  business_name: 200,
  spouse_first_name: 200,
  spouse_last_name: 200,
} as const;
export type ContactField = keyof typeof CONTACT_FIELDS;
const NEVER_BLANK: readonly ContactField[] = ['first_name', 'last_name'];

export interface ClientItemRow {
  id: string;
  list_id: string;
  kind: 'document' | 'question' | 'todo' | 'info';
  sensitive: boolean;
}

export interface ClientListRow {
  id: string;
  title: string;
  status: 'draft' | 'sent' | 'submitted' | 'closed';
  include_contact_confirm: boolean;
}

export interface NeedsContactNames {
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  email: string | null;
}

export type SubmitOutcome = 'submitted' | 'already_submitted' | 'incomplete' | 'not_open' | 'not_found';

export interface NeedsSaveDeps {
  allowedOrigins: string[];
  siteUrl: string | null;
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  /** PII_ENCRYPTION_KEY; null when unset (a sensitive answer is then refused). */
  piiKey: string | null;
  /** The item, only when it belongs to a non-draft list of this contact. */
  loadItem(contactId: string, itemId: string): Promise<ClientItemRow | null>;
  /** The list, only when it is a non-draft list of this contact. */
  loadList(contactId: string, listId: string): Promise<ClientListRow | null>;
  /** A service update of the contact's own row (names and phone only). */
  updateContact(contactId: string, fields: Partial<Record<ContactField, string | null>>): Promise<void>;
  /** needs_client_set_answer: the item's new status, or null when the guard matched nothing. */
  setAnswer(contactId: string, itemId: string, text: string | null, ciphertextHex: string | null): Promise<string | null>;
  /** needs_client_mark_todo. */
  markTodo(contactId: string, itemId: string, done: boolean): Promise<string | null>;
  /** needs_client_link_document: linked, already_linked, or null. */
  linkDocument(contactId: string, itemId: string, documentId: string): Promise<'linked' | 'already_linked' | null>;
  /** needs_client_submit. */
  submit(contactId: string, listId: string): Promise<SubmitOutcome>;
  progress(listId: string): Promise<{ actionable: number; fulfilled: number; required_open: number }>;
  /** Document items on the list, and how many have a file. */
  documentProgress(listId: string): Promise<{ filesIn: number; filesAsked: number }>;
  claimUploadNotice(listId: string): Promise<string | null>;
  releaseUploadNotice(listId: string, stamp: string): Promise<void>;
  loadContact(contactId: string): Promise<NeedsContactNames | null>;
  ownerEmail(): Promise<string | null>;
  loadOrg(): Promise<OrgIdentity>;
  sendEmail(message: { to: string; subject: string; content: EmailContent; fromName: string; idempotencyKey: string }): Promise<SendResult>;
  /** client_activity_log, best effort. */
  logActivity(entry: { contactId: string; userId: string; action: 'profile_update'; details: Record<string, unknown>; ip: string | null; userAgent: string | null }): Promise<void>;
  logSink?: LogSink;
}

function refuse(status: number, error: string, code: string): never {
  throw new HttpError(status, error, code);
}

const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const LOCKED = 'This item can no longer be changed. It was accepted, or the request is no longer open.';

/** The contact fields to write, validated; throws a 400 naming the field's problem. */
export function contactUpdate(raw: unknown): Partial<Record<ContactField, string | null>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse(400, 'Bad request.', 'bad_request');
  const out: Partial<Record<ContactField, string | null>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(CONTACT_FIELDS, key)) refuse(400, 'One of these fields cannot be changed here.', 'invalid_field');
    const field = key as ContactField;
    if (value !== null && typeof value !== 'string') refuse(400, 'Bad request.', 'bad_request');
    const text = typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
    if (text.length > CONTACT_FIELDS[field]) refuse(400, 'One of these values is too long.', 'too_long');
    if (!text) {
      if (NEVER_BLANK.includes(field)) refuse(400, 'A name cannot be blank.', 'blank_name');
      out[field] = null;
      continue;
    }
    out[field] = text;
  }
  if (Object.keys(out).length === 0) refuse(400, 'Nothing to save.', 'nothing_to_save');
  return out;
}

export function createNeedsSaveHandler(deps: NeedsSaveDeps): (req: Request) => Promise<Response> {
  async function notifyUpload(listId: string, contactId: string, log: Logger): Promise<void> {
    if (!deps.siteUrl) return;
    const stamp = await deps.claimUploadNotice(listId);
    if (!stamp) return;
    let sent = false;
    try {
      const to = await deps.ownerEmail();
      const list = await deps.loadList(contactId, listId);
      if (!to || !list) return;
      const [contact, counts, org] = await Promise.all([deps.loadContact(contactId), deps.documentProgress(listId), deps.loadOrg()]);
      const { subject, content } = requestUploadOwnerEmail({
        clientName: clientDisplayName(contact), title: list.title, filesIn: counts.filesIn, filesAsked: counts.filesAsked,
        url: ownerDocumentsUrl(deps.siteUrl, contactId),
      });
      const result = await deps.sendEmail({ to, subject, content, fromName: org.senderName, idempotencyKey: `needs-upload:${listId}:${stamp}` });
      sent = result.status !== 'failed';
      if (!sent) log.warn('upload notice not sent');
    } finally {
      // A notice that did not go gives its claim back, so the next upload tries again.
      if (!sent) {
        try {
          await deps.releaseUploadNotice(listId, stamp);
        } catch (err) {
          log.error('could not release the upload notice claim', err);
        }
      }
    }
  }

  async function submitEmails(listId: string, contactId: string, log: Logger): Promise<void> {
    if (!deps.siteUrl) {
      log.warn('submit emails skipped: SITE_URL is not set');
      return;
    }
    const list = await deps.loadList(contactId, listId);
    if (!list) return;
    const [contact, progress, org, ownerTo] = await Promise.all([
      deps.loadContact(contactId), deps.progress(listId), deps.loadOrg(), deps.ownerEmail(),
    ]);
    if (ownerTo) {
      const { subject, content } = requestSubmittedOwnerEmail({
        clientName: clientDisplayName(contact), title: list.title, fulfilled: progress.fulfilled, actionable: progress.actionable,
        url: ownerRequestsUrl(deps.siteUrl, contactId),
      });
      const r = await deps.sendEmail({ to: ownerTo, subject, content, fromName: org.senderName, idempotencyKey: `needs-submitted-owner:${listId}` });
      if (r.status === 'failed') log.warn('owner submit notice not sent');
    }
    const clientTo = contact?.email?.trim().toLowerCase();
    if (clientTo && isValidEmail(clientTo)) {
      const { subject, content } = requestSubmittedClientEmail({ org, clientName: clientFirstName(contact), title: list.title });
      const r = await deps.sendEmail({ to: clientTo, subject, content, fromName: org.senderName, idempotencyKey: `needs-submitted-client:${listId}` });
      if (r.status === 'failed') log.warn('client submit receipt not sent');
    }
  }

  return createHandler({
    name: 'needs-save',
    allowedOrigins: deps.allowedOrigins,
    auth: { client: deps.authorizeClient },
    clientWrites: true,
    maxBodyBytes: 32768,
    logSink: deps.logSink,
    async handle({ body, json, log, principal, ip, userAgent }) {
      const input = (body ?? {}) as Record<string, unknown>;
      const contactId = principal.contactId;

      switch (input.action) {
        case 'save_contact': {
          if (!isId(input.list_id)) refuse(400, 'Bad request.', 'bad_request');
          const fields = contactUpdate(input.fields);
          const list = await deps.loadList(contactId, input.list_id);
          if (!list) refuse(404, 'This request is not available.', 'not_found');
          if (list.status !== 'sent' || !list.include_contact_confirm) refuse(409, 'This request is not open for changes.', 'not_open');
          await deps.updateContact(contactId, fields);
          try {
            await deps.logActivity({
              contactId, userId: principal.userId, action: 'profile_update', ip, userAgent,
              details: { source: 'request', list_id: list.id, fields: Object.keys(fields).sort(), actor_role: 'client' },
            });
          } catch (err) {
            log.error('could not record the profile update', err);
          }
          return json(200, { status: 'saved' });
        }

        case 'save_answer': {
          if (!isId(input.item_id)) refuse(400, 'Bad request.', 'bad_request');
          if (input.answer !== null && typeof input.answer !== 'string') refuse(400, 'Bad request.', 'bad_request');
          const answer = typeof input.answer === 'string' ? input.answer : '';
          if (answer.length > ANSWER_MAX) refuse(400, `Keep the answer under ${ANSWER_MAX} characters.`, 'too_long');
          const item = await deps.loadItem(contactId, input.item_id);
          if (!item || item.kind !== 'question') refuse(404, 'This item is not available.', 'not_found');
          const blank = answer.trim() === '';
          let text: string | null = null;
          let cipher: string | null = null;
          if (item.sensitive) {
            if (!blank) {
              // Fail closed: a sensitive answer is never stored in the clear.
              if (!deps.piiKey) {
                log.error('PII_ENCRYPTION_KEY is not set; refusing a sensitive answer');
                refuse(503, 'This answer cannot be saved right now. Try again later.', 'encryption_unavailable');
              }
              cipher = toByteaHex(await encryptPii(answer, deps.piiKey));
            }
          } else if (!blank) {
            text = answer;
          }
          const status = await deps.setAnswer(contactId, item.id, text, cipher);
          if (!status) refuse(409, LOCKED, 'locked');
          return json(200, { status });
        }

        case 'mark_item': {
          if (!isId(input.item_id) || typeof input.done !== 'boolean') refuse(400, 'Bad request.', 'bad_request');
          const status = await deps.markTodo(contactId, input.item_id, input.done);
          if (!status) refuse(409, LOCKED, 'locked');
          return json(200, { status });
        }

        case 'link_document': {
          if (!isId(input.item_id) || !isId(input.document_id)) refuse(400, 'Bad request.', 'bad_request');
          const item = await deps.loadItem(contactId, input.item_id);
          if (!item || item.kind !== 'document') refuse(404, 'This item is not available.', 'not_found');
          const linked = await deps.linkDocument(contactId, item.id, input.document_id);
          if (!linked) refuse(409, 'This file could not be attached. The item was accepted, or the request is no longer open.', 'locked');
          if (linked === 'linked') {
            try {
              await notifyUpload(item.list_id, contactId, log);
            } catch (err) {
              log.error('upload notice failed', err);
            }
          }
          return json(200, { status: linked });
        }

        case 'submit': {
          if (!isId(input.list_id)) refuse(400, 'Bad request.', 'bad_request');
          const outcome = await deps.submit(contactId, input.list_id);
          if (outcome === 'not_found') refuse(404, 'This request is not available.', 'not_found');
          if (outcome === 'not_open') refuse(409, 'This request is no longer open.', 'not_open');
          if (outcome === 'incomplete') refuse(409, 'Answer every required item before submitting.', 'incomplete');
          if (outcome === 'submitted') {
            try {
              await submitEmails(input.list_id, contactId, log);
            } catch (err) {
              log.error('submit emails failed', err);
            }
          }
          return json(200, { status: outcome });
        }

        default:
          refuse(400, 'Bad request.', 'bad_request');
      }
    },
  });
}
