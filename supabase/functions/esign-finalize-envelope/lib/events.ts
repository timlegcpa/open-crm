// The envelope event log: one writer, the labels the on-demand audit PDF prints, and the
// sentences the executed PDF's audit trail prints.

import type { Logger } from '../../_shared/log.ts';
import { pgCode, type EsignDb } from './db.ts';
import { resolveSignerName, type SignerLike } from './signer-name.ts';

export const EVENT_TYPES = [
  'envelope_created', 'envelope_sent', 'envelope_voided', 'envelope_expired',
  'invite_sent', 'invite_resent', 'email_delivered', 'email_opened',
  'signer_opened_link', 'signer_viewed_pdf', 'sms_code_sent', 'sms_code_verified',
  'sms_code_failed', 'signer_signed', 'envelope_completed', 'rate_limit_hit',
  'consent_accepted', 'signer_declined',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The on-demand audit PDF's label per event type (the owner's event table shows the same words). */
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
  signer_opened_link: 'Opened sign link',
  signer_viewed_pdf: 'Viewed PDF',
  signer_signed: 'Signed',
  signer_declined: 'Declined',
  sms_code_sent: 'SMS code sent',
  sms_code_verified: 'SMS code verified',
  sms_code_failed: 'SMS code failed',
  rate_limit_hit: 'Rate limit hit',
  consent_accepted: 'Consent accepted',
};

export interface EventInput {
  envelope_id: string;
  signer_id?: string | null;
  event_type: EventType;
  /** ctx.ip: an IP literal or null, never a placeholder string (the column is inet). */
  ip?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record an event. The event log is evidence but never the state: a failed insert is
 * logged and the request carries on, as every caller at the pin did.
 */
export async function recordEvent(db: EsignDb, log: Logger, event: EventInput): Promise<void> {
  try {
    const { error } = await db.from('esign_envelope_events').insert({
      envelope_id: event.envelope_id,
      signer_id: event.signer_id ?? null,
      event_type: event.event_type,
      ip: event.ip ?? null,
      user_agent: event.user_agent ? event.user_agent.slice(0, 512) : null,
      metadata: event.metadata ?? {},
    });
    if (error) log.error('event insert failed', error, { event: event.event_type, envelope_id: event.envelope_id });
  } catch (err) {
    log.error('event insert failed', err, { event: event.event_type, code: pgCode(err) ?? null });
  }
}

/** Who did it, for an audit-trail sentence. */
function who(s: SignerLike | undefined): string {
  if (!s) return 'A signer';
  return `${resolveSignerName(s)} (${s.email})`;
}

/**
 * The executed PDF's audit trail, one sentence per event that belongs on a certificate.
 * Diagnostics (rate limits, failed codes, the draft's creation) are left out.
 */
export function auditPhrase(
  eventType: string,
  signer: SignerLike | undefined,
  metadata: Record<string, unknown> | null,
): string | null {
  switch (eventType) {
    case 'envelope_sent':
      return 'Envelope sent for signature.';
    case 'invite_sent':
      return `Email notification sent to ${who(signer)}.`;
    case 'invite_resent':
      return `Email notification re-sent to ${who(signer)}.`;
    case 'email_delivered':
      return `Email notification delivered to ${who(signer)}.`;
    case 'email_opened':
      return `${who(signer)} opened the email notification.`;
    case 'signer_opened_link':
      return `${who(signer)} opened the sign link.`;
    case 'signer_viewed_pdf':
      return `${who(signer)} viewed the document(s).`;
    case 'sms_code_sent': {
      const last4 = typeof metadata?.last_four === 'string' && /^\d{4}$/.test(metadata.last_four) ? metadata.last_four : null;
      return `SMS verification code sent to ${signer ? resolveSignerName(signer) : 'the signer'}'s phone${last4 ? ` ending in ${last4}` : ''}.`;
    }
    case 'sms_code_verified':
      return `${who(signer)} verified the SMS code.`;
    case 'consent_accepted':
      return `${who(signer)} agreed to the electronic signature consent.`;
    case 'signer_signed':
      return `${who(signer)} electronically signed the document(s).`;
    default:
      return null;
  }
}
