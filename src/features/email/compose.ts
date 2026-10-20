import { isArchived, type ContactListRow } from '@/api/contacts';
import { isEmailableStatus } from '@/lib/contactStatus';
import { isEdgeError } from '@/lib/edgeCore';

/**
 * At or above this many recipients the owner types the count to confirm. A slip that
 * mails eight people is recoverable; one that mails eighty is a reputation event. The
 * server enforces the real cap: this is a speed bump, not a control.
 */
export const TYPED_CONFIRM_THRESHOLD = 25;

/** The server's ceiling (crm-send-group-email MAX_RECIPIENTS). */
export const MAX_RECIPIENTS = 250;

export interface Skipped {
  contact: ContactListRow;
  why: string;
}

/**
 * A PREVIEW of the server's decision, from the same facts: the contact is not archived, the
 * status may be emailed and contacts.email (which the database keeps equal to the default primary address) is set.
 * The server re-resolves every recipient from the ids and applies suppression itself; the
 * browser never supplies an address to send to.
 */
export function splitRecipients(
  contacts: readonly ContactListRow[],
  statusLabel: (key: string) => string,
): { eligible: ContactListRow[]; skipped: Skipped[] } {
  const eligible: ContactListRow[] = [];
  const skipped: Skipped[] = [];
  for (const c of contacts) {
    if (isArchived(c)) skipped.push({ contact: c, why: 'Archived' });
    else if (!isEmailableStatus(c.status)) skipped.push({ contact: c, why: `${statusLabel(c.status)} is never emailed` });
    else if (!c.email?.trim()) skipped.push({ contact: c, why: 'No email address' });
    else eligible.push(c);
  }
  return { eligible, skipped };
}

/** Recipient ids from the `to` query parameter (links.newGroupEmail): known-good ids, once each, capped. */
export function idsFromQuery(value: string | null, isUuid: (v: string) => boolean): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((v) => v.trim()).filter(isUuid))].slice(0, MAX_RECIPIENTS);
}

/**
 * What to show for a failed call. A 5xx message is never shown as written (edgeCore keeps
 * server internals off the screen), so the two configuration refusals are named by code.
 */
export function sendErrorMessage(err: unknown): string {
  if (isEdgeError(err)) {
    if (err.code === 'site_url_missing') return 'Group email needs the SITE_URL setting on the server, for the unsubscribe link.';
    if (err.code === 'email_not_configured') return 'Email is not configured on the server. Set RESEND_API_KEY and EMAIL_FROM.';
    return err.message;
  }
  return 'Something went wrong. Try again.';
}
