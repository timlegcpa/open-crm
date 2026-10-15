// The connector's outward arm: sending and reminding a request, and the owner's copy.
//
// In process, on purpose. send_request and remind_request run send-needs-list's own
// sendList and remindList here, over the same store, instead of calling that function over
// HTTP with a shared secret. One code path sends a request whoever asks; there is no
// second credential the send-needs-list endpoint accepts, so nothing a browser could
// present reaches the connector's path; and no gateway setting or secret header has to
// be kept right. What the connector reviewed travels with the call (Reviewed): the content
// version its token was verified over, which the publish compares, and the address it read
// back, which the send re-checks against the contact it loads.
//
// Every message leaves through the store's sendEmail (the outbound adapter). The owner's
// copy is how the owner sees what an assistant mailed a client with no person in the loop;
// whether it went is reported to the caller, never assumed.

import type { EmailContent } from '../_shared/email-layout.ts';
import type { Logger } from '../_shared/log.ts';
import { oneLine, ownerRequestsUrl } from '../send-needs-list/needs-email.ts';
import { remindList, sendList, type NeedsSendStore } from '../send-needs-list/handler.ts';

export type OutwardSend =
  | { status: 'sent'; email: boolean | null }
  | { status: 'already_sent' | 'changed' | 'gone' | 'no_items' | 'no_email' | 'not_draft' };

export type OutwardRemind =
  | { status: 'reminded'; email: 'sent' | 'unknown'; remaining: number }
  | { status: 'not_sent' | 'nothing_open' | 'no_email' | 'email_failed' | 'changed' | 'gone' };

/** What the owner's copy says went out. */
export interface Receipt {
  action: 'sent' | 'reminded';
  listId: string;
  contactId: string;
  recipientName: string;
  recipientEmail: string;
  title: string;
  intro: string | null;
  items: ReadonlyArray<{ label: string; kind: string; required: boolean }>;
  /** Whether the client's email was accepted: true, false, or null when its answer was lost. */
  clientEmail: boolean | null;
  /** A per-act key, so a retried copy is not delivered twice. */
  key: string;
}

export interface RequestOutward {
  send(input: { listId: string; actor: string; version: number; email: string }, log: Logger): Promise<OutwardSend>;
  remind(input: { listId: string; actor: string; email: string }, log: Logger): Promise<OutwardRemind & { reminderCount?: number }>;
  /** The owner's copy of what went out. true only when the provider accepted it. */
  receipt(receipt: Receipt): Promise<boolean>;
  /** An out-of-band note to the owner (an outward act whose audit row could not be written). */
  alert(subject: string, lines: readonly string[], key: string): Promise<boolean>;
}

export function createRequestOutward(deps: {
  store: NeedsSendStore;
  siteUrl: string | null;
  /** The owner's current sign-in address (loadOwnerEmail), or null. */
  ownerEmail(): Promise<string | null>;
}): RequestOutward {
  const { store } = deps;
  const site = (): string => {
    // mcp-crm refuses to serve without SITE_URL before any tool runs; this is the backstop.
    if (!deps.siteUrl) throw new Error('SITE_URL is not set');
    return deps.siteUrl;
  };

  async function toOwner(subject: string, content: EmailContent, key: string): Promise<boolean> {
    const to = await deps.ownerEmail();
    if (!to) return false;
    const org = await store.loadOrg();
    const result = await store.sendEmail({ to, subject, content, fromName: org.senderName, idempotencyKey: key });
    return result.status === 'sent';
  }

  return {
    async send({ listId, actor, version, email }, log) {
      const list = await store.loadList(listId);
      if (!list) return { status: 'gone' };
      const result = await sendList(store, site(), list, actor, log, { version, email });
      return result.status === 'sent' ? { status: 'sent', email: result.email } : { status: result.status };
    },

    async remind({ listId, actor, email }, log) {
      const list = await store.loadList(listId);
      if (!list) return { status: 'gone' };
      const result = await remindList(store, site(), list, actor, log, { email });
      if (result.status !== 'reminded') return { status: result.status };
      return { status: 'reminded', email: result.email, remaining: result.remaining, reminderCount: list.reminder_count };
    },

    receipt(r) {
      const verb = r.action === 'sent' ? 'sent' : 'sent a reminder about';
      const delivery = r.clientEmail === true
        ? 'The email to the client was accepted for delivery.'
        : r.clientEmail === false
          ? 'The email to the client DID NOT go out. The request is visible in their portal; send a reminder from the CRM.'
          : 'Whether the email to the client was delivered is unknown (the provider did not answer).';
      const blocks: EmailContent['blocks'][number][] = [
        { kind: 'heading', text: `Your AI assistant ${verb} a request` },
        { kind: 'paragraph', text: `To: ${oneLine(r.recipientName) || 'this contact'} <${r.recipientEmail}>\nTitle: ${oneLine(r.title)}` },
      ];
      if (r.intro) blocks.push({ kind: 'paragraph', text: r.intro });
      blocks.push({ kind: 'list', items: r.items.map((it) => `${it.label} (${it.kind}${it.required ? '' : ', optional'})`) });
      blocks.push({ kind: 'paragraph', text: delivery });
      blocks.push({ kind: 'button', label: 'Open the requests', url: ownerRequestsUrl(site(), r.contactId) });
      blocks.push({ kind: 'note', text: 'You get this copy for everything an AI assistant connected to your CRM emails a client.' });
      const subject = `${r.action === 'sent' ? 'Sent by your AI assistant' : 'Reminder sent by your AI assistant'}: ${oneLine(r.title)}`;
      return toOwner(subject, { preheader: 'A copy of what went out.', blocks }, r.key);
    },

    alert(subject, lines, key) {
      return toOwner(subject, { blocks: lines.map((text) => ({ kind: 'paragraph' as const, text })) }, key);
    },
  };
}
