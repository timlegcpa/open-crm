import { NO_VALUE_TEXT } from '@/lib/format';
import type { EventType } from '../contract';

/**
 * What each envelope event is called in the owner's event log. The audit PDF the server
 * renders labels the same events; the two lists must agree (eventLabels.test.ts).
 */
export const EVENT_LABELS: Record<EventType, string> = {
  envelope_created: 'Envelope created',
  envelope_sent: 'Envelope sent',
  envelope_voided: 'Envelope voided',
  envelope_expired: 'Envelope expired',
  envelope_completed: 'Envelope completed',
  invite_sent: 'Invite sent',
  invite_resent: 'Invite resent',
  email_delivered: 'Email delivered',
  email_opened: 'Email opened',
  signer_opened_link: 'Opened the signing link',
  signer_viewed_pdf: 'Viewed the document',
  consent_accepted: 'Consent accepted',
  signer_signed: 'Signed',
  signer_declined: 'Declined',
  sms_code_sent: 'SMS code sent',
  sms_code_verified: 'SMS code verified',
  sms_code_failed: 'SMS code failed',
  rate_limit_hit: 'Rate limit hit',
};

export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The one-line note beside an event, read from the metadata each producer writes. Every
 * key read here is one a function writes; an unknown shape falls back to a short JSON.
 */
export function summarizeEvent(type: string, metadata: Record<string, unknown> | null | undefined): string {
  const meta = metadata && typeof metadata === 'object' ? metadata : null;
  if (!meta) return NO_VALUE_TEXT;
  switch (type) {
    case 'envelope_voided': {
      const reason = str(meta.void_reason);
      return reason ? `Reason: ${reason}` : NO_VALUE_TEXT;
    }
    case 'signer_declined': {
      const reason = str(meta.reason);
      return reason ? `Reason: ${reason}` : NO_VALUE_TEXT;
    }
    case 'envelope_sent': {
      // send-envelope writes { signers_invited, invite_failures, source_pdf_sha256 }.
      const count = num(meta.signers_invited);
      if (count === null) return NO_VALUE_TEXT;
      const failures = num(meta.invite_failures) ?? 0;
      const base = `${count} signer${count === 1 ? '' : 's'} invited`;
      return failures > 0 ? `${base}, ${failures} not delivered` : base;
    }
    case 'invite_sent':
    case 'invite_resent': {
      const to = str(meta.email);
      return to ? `To ${to}` : NO_VALUE_TEXT;
    }
    case 'email_delivered':
    case 'email_opened': {
      const subject = str(meta.subject);
      return subject || NO_VALUE_TEXT;
    }
    case 'signer_signed': {
      // sign writes { font_key, timezone, consent_version }: the zone is a tamper signal and
      // the version names the disclosure text accepted.
      const parts = [str(meta.timezone), str(meta.consent_version) ? `consent ${str(meta.consent_version)}` : ''].filter(Boolean);
      return parts.length ? parts.join(' · ') : NO_VALUE_TEXT;
    }
    case 'sms_code_sent': {
      // request-sms writes the last four only; the number itself stays encrypted.
      const lastFour = str(meta.last_four);
      return lastFour ? `Sent to •••• ${lastFour}` : NO_VALUE_TEXT;
    }
    case 'sms_code_failed': {
      const attempts = num(meta.attempts);
      return attempts !== null ? `Attempts: ${attempts}` : NO_VALUE_TEXT;
    }
    case 'rate_limit_hit': {
      const scope = str(meta.scope);
      return scope ? `Scope: ${scope}` : NO_VALUE_TEXT;
    }
    case 'envelope_completed':
      return 'Stamped, audit trail added, copies emailed';
    case 'envelope_created': {
      const title = str(meta.title);
      return title ? `Title: ${title}` : NO_VALUE_TEXT;
    }
    default: {
      const json = JSON.stringify(meta);
      if (json === '{}') return NO_VALUE_TEXT;
      return json.length > 80 ? `${json.slice(0, 77)}...` : json;
    }
  }
}
