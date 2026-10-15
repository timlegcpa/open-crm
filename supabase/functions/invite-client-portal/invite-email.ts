// The portal invitation: its lifetime, its link and its email, shared by a new invite
// and a resend so the two cannot drift apart. Plain TypeScript, no Deno global.

import type { EmailContent } from '../_shared/email-layout.ts';
import type { OrgIdentity } from '../_shared/organization.ts';

export const INVITE_EXPIRY_DAYS = 7;

export type InviteVariant = 'initial' | 'resend';

/** When a link minted at `now` stops working. */
export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The link in the email. The token travels in the fragment: a browser never sends a
 * fragment to a server, so it cannot land in a host's request log or a Referer header.
 */
export function inviteUrl(siteUrl: string, rawToken: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/invite#token=${rawToken}`;
}

/** e.g. "Friday, May 1, 2026 at 3:04 PM UTC". UTC, said so: the organization's zone is not known here. */
export function formatExpiry(at: Date): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  return `${text} UTC`;
}

export function inviteSubject(org: OrgIdentity, variant: InviteVariant): string {
  return variant === 'initial'
    ? `Your client portal invitation from ${org.displayName}`
    : `A new portal invitation from ${org.displayName}`;
}

export function inviteContent(opts: {
  org: OrgIdentity;
  variant: InviteVariant;
  firstName: string | null;
  url: string;
  expiresAt: Date;
}): EmailContent {
  const name = opts.firstName?.trim();
  const greeting = name ? `Welcome, ${name}` : 'Welcome';
  const intro =
    opts.variant === 'initial'
      ? `${opts.org.displayName} has invited you to a secure client portal. There you can:`
      : `Here is a new invitation to your client portal. Any earlier invitation link no longer works. There you can:`;
  return {
    preheader: `Set up your sign-in to the ${opts.org.displayName} client portal.`,
    blocks: [
      { kind: 'heading', text: greeting },
      { kind: 'paragraph', text: intro },
      { kind: 'list', items: ['See what is waiting on you', 'Share documents securely', 'Send secure messages'] },
      { kind: 'button', label: 'Set up your account', url: opts.url },
      {
        kind: 'paragraph',
        text: `This link works for ${INVITE_EXPIRY_DAYS} days, until ${formatExpiry(opts.expiresAt)}. If it runs out, reply to this email and we will send a new one.`,
      },
      { kind: 'note', text: 'If you did not expect this email, you can ignore it.' },
    ],
  };
}
