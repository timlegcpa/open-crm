// Every e-signature email, as content blocks for the one layout (_shared/email-layout.ts).
// Written in the organization's voice ("{org} sent you ..."), never a person's, and
// naming no one but the organization and the recipient.

import type { EmailBlock, EmailContent } from '../../_shared/email-layout.ts';
import type { OrgIdentity } from '../../_shared/organization.ts';
import { SIGNING_LINK_DAYS } from './text.ts';

export interface DraftEmail {
  subject: string;
  content: EmailContent;
}

const greeting = (name: string | null) => (name && name.trim() ? `Hi ${name.trim()},` : 'Hello,');

/** The invitation (send and resend). */
export function inviteEmail(p: { org: OrgIdentity; recipientName: string | null; title: string; url: string; high: boolean }): DraftEmail {
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: greeting(p.recipientName) },
    { kind: 'paragraph', text: `${p.org.displayName} sent you "${p.title}" to sign electronically.` },
  ];
  if (p.high) {
    blocks.push({ kind: 'paragraph', text: 'Before you sign, you will be asked for a 6-digit code sent by text message to your phone.' });
  }
  blocks.push(
    { kind: 'button', label: 'Review and sign', url: p.url },
    {
      kind: 'note',
      text: `This link is yours alone and works for ${SIGNING_LINK_DAYS} days. If you were not expecting it, you can ignore this email.`,
    },
  );
  return {
    subject: `Please sign: ${p.title}`,
    content: { preheader: `${p.org.displayName} sent you a document to sign.`, blocks },
  };
}

/** The executed copy, to every signer and the owner, with the PDF attached. */
export function completedEmail(p: { org: OrgIdentity; recipientName: string | null; title: string }): DraftEmail {
  return {
    subject: `Signed: ${p.title}`,
    content: {
      preheader: 'Everyone has signed. Your copy is attached.',
      blocks: [
        { kind: 'paragraph', text: greeting(p.recipientName) },
        { kind: 'paragraph', text: `"${p.title}" has been signed by everyone and is complete. The signed copy is attached.` },
        { kind: 'note', text: 'Keep this copy for your records. The last page is the audit trail of how it was signed.' },
      ],
    },
  };
}

/** The signing request was cancelled: to every signer who had not signed, and the owner. */
export function voidedEmail(p: { org: OrgIdentity; recipientName: string | null; title: string }): DraftEmail {
  return {
    subject: `Cancelled: ${p.title}`,
    content: {
      blocks: [
        { kind: 'paragraph', text: greeting(p.recipientName) },
        { kind: 'paragraph', text: `${p.org.displayName} cancelled the signing request for "${p.title}". The link in the earlier email no longer works.` },
        { kind: 'note', text: 'If you have a question about it, reply to this email.' },
      ],
    },
  };
}

/** To the owner only: a signer declined. */
export function declinedAlertEmail(p: {
  org: OrgIdentity;
  title: string;
  signerName: string;
  signerEmail: string;
  reason: string | null;
  esignUrl: string;
}): DraftEmail {
  return {
    subject: `Signer declined: ${p.title}`,
    content: {
      blocks: [
        { kind: 'heading', text: 'A signer declined' },
        { kind: 'paragraph', text: `${p.signerName} (${p.signerEmail}) declined to sign "${p.title}".` },
        { kind: 'paragraph', text: p.reason ? `Reason given: ${p.reason}` : 'No reason was given.' },
        {
          kind: 'paragraph',
          text: 'The envelope is now marked declined and its signing links no longer work. Send a new envelope if it still needs signing.',
        },
        { kind: 'button', label: 'Open e-signature', url: p.esignUrl },
      ],
    },
  };
}

/** To the owner: the daily expiry run's summary. */
export function expirySummaryEmail(p: { envelopes: ReadonlyArray<{ title: string; signersExpired: number }>; esignUrl: string }): DraftEmail {
  const n = p.envelopes.length;
  return {
    subject: `${n} signing request${n === 1 ? '' : 's'} expired`,
    content: {
      blocks: [
        { kind: 'heading', text: 'Expired signing requests' },
        { kind: 'paragraph', text: `${n} envelope${n === 1 ? '' : 's'} passed the signing deadline and ${n === 1 ? 'is' : 'are'} now expired.` },
        {
          kind: 'list',
          items: p.envelopes.map((e) => `${e.title} (${e.signersExpired} signer${e.signersExpired === 1 ? '' : 's'} had not signed)`),
        },
        { kind: 'button', label: 'Open e-signature', url: p.esignUrl },
      ],
    },
  };
}

/** The text message carrying a code. */
export function smsCodeText(orgName: string, code: string, minutes: number): string {
  return `${orgName}: your signing code is ${code}. It expires in ${minutes} minutes.`;
}
