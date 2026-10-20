// Requests: every email a request sends, and the links in them, in one place so the send,
// the reminder (manual and scheduled), the submit receipts, the upload notice and the
// start-link notice cannot drift apart. Used by send-needs-list, needs-reminder-dispatcher,
// needs-save and accept-start-link. Plain TypeScript, no Deno global.
//
// Every builder takes RAW strings: renderEmail escapes them. A subject is one line, so the
// client-typed parts of it (a name, a title) lose their line breaks here.

import type { EmailContent } from '../_shared/email-layout.ts';
import type { OrgIdentity } from '../_shared/organization.ts';

/** How long a start link works. */
export const START_LINK_EXPIRY_DAYS = 14;

/** When a start link minted at `now` stops working. */
export function startLinkExpiry(now: Date): Date {
  return new Date(now.getTime() + START_LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

const base = (siteUrl: string) => siteUrl.replace(/\/+$/, '');

/**
 * The link for a contact with no portal account yet. The token travels in the fragment:
 * a browser never sends a fragment to a server, so it cannot land in a request log or a
 * Referer header.
 */
export function startLinkUrl(siteUrl: string, rawToken: string): string {
  return `${base(siteUrl)}/start#token=${rawToken}`;
}

/** The request in the portal (links.ts portalRequest). */
export function portalRequestUrl(siteUrl: string, listId: string): string {
  return `${base(siteUrl)}/portal/requests/${listId}`;
}

/** The contact's requests tab, for the owner (links.ts contactTab(id, 'requests')). */
export function ownerRequestsUrl(siteUrl: string, contactId: string): string {
  return `${base(siteUrl)}/contacts/${contactId}/requests`;
}

/** The contact's documents, for the owner (links.ts documents). */
export function ownerDocumentsUrl(siteUrl: string, contactId: string): string {
  return `${base(siteUrl)}/documents?contact=${contactId}`;
}

/** The contact, for the owner (links.ts contact). */
export function ownerContactUrl(siteUrl: string, contactId: string): string {
  return `${base(siteUrl)}/contacts/${contactId}`;
}

/** One line: a subject never carries a break a client typed. */
export function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const greeting = (name: string) => (name.trim() ? `Hi ${oneLine(name)},` : 'Hello,');

/** A new request, to the contact. */
export function requestSentEmail(input: {
  org: OrgIdentity;
  clientName: string;
  title: string;
  itemCount: number;
  intro: string | null;
  url: string;
  /** The link sets up a portal account first (a start link). */
  startLink: boolean;
}): { subject: string; content: EmailContent } {
  const blocks: EmailContent['blocks'][number][] = [
    { kind: 'heading', text: greeting(input.clientName) },
    { kind: 'paragraph', text: `${input.org.displayName} has sent you a request: ${oneLine(input.title)} (${plural(input.itemCount, 'item')}).` },
  ];
  if (input.intro && input.intro.trim()) blocks.push({ kind: 'paragraph', text: input.intro.trim() });
  blocks.push({ kind: 'button', label: input.startLink ? 'Set up access and open' : 'Open the request', url: input.url });
  if (input.startLink) {
    blocks.push({
      kind: 'note',
      text: `The link sets up your secure portal sign-in. It works for ${START_LINK_EXPIRY_DAYS} days.`,
    });
  }
  return {
    subject: `New request: ${oneLine(input.title)}`,
    content: { preheader: `${input.org.displayName} needs a few things from you.`, blocks },
  };
}

/** A reminder, to the contact, with how many items are still open. */
export function requestReminderEmail(input: {
  org: OrgIdentity;
  clientName: string;
  title: string;
  remaining: number;
  url: string;
  startLink: boolean;
}): { subject: string; content: EmailContent } {
  const blocks: EmailContent['blocks'][number][] = [
    { kind: 'heading', text: greeting(input.clientName) },
    { kind: 'paragraph', text: `A reminder about ${oneLine(input.title)}: ${plural(input.remaining, 'item')} still open.` },
    { kind: 'button', label: input.startLink ? 'Set up access and open' : 'Open the request', url: input.url },
  ];
  if (input.startLink) {
    blocks.push({ kind: 'note', text: `This is a fresh link; any earlier one no longer works. It works for ${START_LINK_EXPIRY_DAYS} days.` });
  }
  return {
    subject: `Reminder: ${oneLine(input.title)}`,
    content: { preheader: `${plural(input.remaining, 'item')} still open.`, blocks },
  };
}

/** A submitted request, to the owner. */
export function requestSubmittedOwnerEmail(input: {
  clientName: string;
  title: string;
  fulfilled: number;
  actionable: number;
  url: string;
}): { subject: string; content: EmailContent } {
  const who = oneLine(input.clientName) || 'A client';
  return {
    subject: `Request submitted: ${oneLine(input.title)}`,
    content: {
      preheader: `${who} submitted a request.`,
      blocks: [
        { kind: 'heading', text: 'Request submitted' },
        { kind: 'paragraph', text: `${who} submitted ${oneLine(input.title)}: ${input.fulfilled} of ${plural(input.actionable, 'item')} answered.` },
        { kind: 'button', label: 'Open the requests', url: input.url },
      ],
    },
  };
}

/** The contact's receipt for a submit. */
export function requestSubmittedClientEmail(input: {
  org: OrgIdentity;
  clientName: string;
  title: string;
}): { subject: string; content: EmailContent } {
  return {
    subject: `Received: ${oneLine(input.title)}`,
    content: {
      preheader: 'Thanks, your request is in.',
      blocks: [
        { kind: 'heading', text: greeting(input.clientName) },
        { kind: 'paragraph', text: `Thanks for submitting ${oneLine(input.title)}. ${input.org.displayName} has received it and will follow up if anything else is needed.` },
      ],
    },
  };
}

/**
 * An upload to a request, to the owner, at most once per list per 24 hours. No file
 * names: the client typed them.
 */
export function requestUploadOwnerEmail(input: {
  clientName: string;
  title: string;
  filesIn: number;
  filesAsked: number;
  url: string;
}): { subject: string; content: EmailContent } {
  const who = oneLine(input.clientName) || 'A client';
  return {
    subject: `New upload: ${oneLine(input.title)}`,
    content: {
      preheader: `${who} uploaded a file.`,
      blocks: [
        { kind: 'heading', text: 'New upload to a request' },
        { kind: 'paragraph', text: `${who} uploaded to ${oneLine(input.title)}. ${input.filesIn} of ${plural(input.filesAsked, 'requested file')} in.` },
        { kind: 'button', label: 'Open the documents', url: input.url },
      ],
    },
  };
}

/** A start link redeemed, to the owner. */
export function startLinkAccountOwnerEmail(input: {
  clientName: string;
  email: string;
  url: string;
}): { subject: string; content: EmailContent } {
  const who = oneLine(input.clientName) || input.email;
  return {
    subject: `Portal account created: ${who}`,
    content: {
      preheader: `${who} set up their portal account.`,
      blocks: [
        { kind: 'heading', text: 'Portal account created' },
        { kind: 'paragraph', text: `${who} (${input.email}) set a password and created their portal account from a request link.` },
        { kind: 'button', label: 'Open the contact', url: input.url },
      ],
    },
  };
}

/** The name a request email greets: the contact's first name, else nothing. */
export function clientFirstName(contact: { first_name?: string | null } | null): string {
  return oneLine(contact?.first_name ?? '');
}

/** The name an owner email names: first and last, else the business, else nothing. */
export function clientDisplayName(
  contact: { first_name?: string | null; last_name?: string | null; business_name?: string | null } | null,
): string {
  const person = oneLine([contact?.first_name, contact?.last_name].filter(Boolean).join(' '));
  return person || oneLine(contact?.business_name ?? '');
}
