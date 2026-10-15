/**
 * What each `client_activity_log` action reads as on a contact's Activity tab. The keys are
 * exactly the table's CHECK list in 0002_contacts.sql (crm's lib.test.ts parses it), so a new
 * action cannot arrive without a label. An action the catalog does not know still renders,
 * under its raw key.
 */

export type ActivityTone = 'default' | 'success' | 'warn' | 'danger' | 'info';

export interface ActivityMeta {
  label: string;
  tone: ActivityTone;
  /** A one-line detail from the row's `details`, or '' when there is none. */
  format?: (details: Record<string, unknown>) => string;
}

/** A scalar detail as text; an object or array never renders as "[object Object]". */
const text = (value: unknown): string => (value == null || typeof value === 'object' ? '' : String(value));

const fileName = (d: Record<string, unknown>) => text(d.filename);

export const ACTIVITY_CATALOG: Record<string, ActivityMeta> = {
  login: { label: 'Signed in', tone: 'info' },
  logout: { label: 'Signed out', tone: 'default' },
  session_start: { label: 'Session started', tone: 'default' },
  session_expired: { label: 'Session expired', tone: 'warn' },
  invitation_accepted: { label: 'Invitation accepted', tone: 'success' },
  start_link_consumed: { label: 'Start link used', tone: 'success' },
  profile_update: { label: 'Profile updated', tone: 'default' },
  password_change: { label: 'Password changed', tone: 'default' },
  password_reset_sent: { label: 'Password reset sent', tone: 'info' },
  document_upload: { label: 'Document uploaded', tone: 'success', format: fileName },
  document_download: { label: 'Document downloaded', tone: 'default', format: fileName },
  document_delete: {
    label: 'Document deleted',
    tone: 'danger',
    format: (d) => {
      const count = Number(d.count);
      if (count > 0) return `${count} document${count === 1 ? '' : 's'}${text(d.folder) ? ` in ${text(d.folder)}` : ''}`;
      return fileName(d);
    },
  },
  message_sent: { label: 'Message sent', tone: 'info' },
  message_read: {
    label: 'Message read',
    tone: 'info',
    format: (d) => {
      const count = Number(d.count);
      return count > 1 ? `${count} messages` : '';
    },
  },
  esign_signed: { label: 'Document signed', tone: 'success', format: (d) => text(d.envelope_title) },
  email_sent: { label: 'Email sent', tone: 'default', format: (d) => text(d.subject) },
  account_suspended: { label: 'Account suspended', tone: 'danger' },
  account_reactivated: { label: 'Account reactivated', tone: 'success' },
  account_deleted: { label: 'Account deleted', tone: 'danger' },
};

export const TONE_DOT_CLASS: Record<ActivityTone, string> = {
  default: 'bg-muted-foreground',
  success: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-link',
};

export function describeActivity(action: string, details: Record<string, unknown> | null): { meta: ActivityMeta; detail: string } {
  const meta = ACTIVITY_CATALOG[action] ?? { label: action, tone: 'default' as const };
  return { meta, detail: meta.format ? meta.format(details ?? {}) : '' };
}
