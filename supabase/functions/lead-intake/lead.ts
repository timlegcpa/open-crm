// The lead-intake contract: what a sender may post, how it is checked, and what is stored
// and sent from it. Pure TypeScript, tested by src/__tests__/edge/leadIntake.test.ts.
//
// The edge function runs as the service role, which bypasses every grant and policy that
// protects the owner's own contact form. So this parser and lead_intake_record are the
// whole guard between a sender's JSON and a contacts row: only the fields below are read,
// and the status and source of a new contact are constants in SQL, never in the payload.

import type { EmailContent } from '../_shared/email-layout.ts';

export interface Lead {
  external_id: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  business_name: string | null;
  notes: string | null;
}

export type ParsedLead = { ok: true; lead: Lead } | { ok: false; error: string };

/**
 * THE request contract. external_id is required and carries all of retry detection:
 * which delivery this is and which person it is are different questions, and answering
 * both with the address would make a second lead for a known person look like a retry.
 */
const FIELDS = [
  { key: 'external_id', required: true, max: 128 },
  { key: 'first_name', required: true, max: 100 },
  { key: 'last_name', required: false, max: 100 },
  { key: 'email', required: true, max: 254 },
  { key: 'phone', required: false, max: 40 },
  { key: 'business_name', required: false, max: 200 },
  { key: 'notes', required: false, max: 5000 },
] as const;

/**
 * Restricted, never cleaned up: cleaning would map two different sender ids onto one
 * and merge two deliveries. The same rule is a CHECK on lead_intake_deliveries.
 */
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * An address with no CR, LF or NUL (it reaches an email header and a mailto: link, where a
 * newline is header injection) and a plain local@domain shape.
 */
export function isValidLeadEmail(email: string): boolean {
  if (/[\r\n\0]/.test(email) || email.length > 254) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);
}

/**
 * Check and normalise one posted lead. Types are checked, never coerced
 * ({"first_name": 42} is refused, not stored as "42"), so a sender building to the
 * contract hears about a wrong type at once. Whitespace-only counts as absent, so a
 * required field cannot be met with a space. Unknown keys are dropped, not refused, so a
 * sender adding a field of their own never starts failing.
 */
export function parseLead(raw: unknown): ParsedLead {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The body must be a JSON object.' };
  const src = raw as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const { key, required, max } of FIELDS) {
    const value = Object.hasOwn(src, key) ? src[key] : undefined;
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: `Field "${key}" must be a string.` };
    }
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      if (required) return { ok: false, error: `Field "${key}" is required.` };
      out[key] = null;
      continue;
    }
    if (trimmed.length > max) return { ok: false, error: `Field "${key}" is longer than ${max} characters.` };
    out[key] = trimmed;
  }
  if (!EXTERNAL_ID.test(out.external_id!)) {
    return { ok: false, error: 'Field "external_id" may hold only letters, digits and . _ : -, starting with a letter or digit.' };
  }
  if (!isValidLeadEmail(out.email!)) return { ok: false, error: 'Field "email" is not a valid email address.' };
  return {
    ok: true,
    lead: {
      external_id: out.external_id!,
      first_name: out.first_name!,
      last_name: out.last_name,
      email: out.email!,
      phone: out.phone,
      business_name: out.business_name,
      notes: out.notes,
    },
  };
}

/**
 * The label over the sender's free text, in the note and in the owner's notice. Whatever
 * the sender writes arrives under it, so it can never pass for the owner's own words or
 * for a fact the app checked.
 */
export const SENDER_NOTES_LABEL = 'Notes from the sender (not verified):';

/**
 * The note stored on the contact (a new lead's, or a match's): the delivery id, so a contact
 * can be traced back to the sender's own record, then the business, phone and the sender's
 * notes under SENDER_NOTES_LABEL. Well inside the
 * 10,000-character cap on contact_notes: the only long input, notes, is capped at 5,000.
 */
export function leadNoteBody(lead: Lead): string {
  const lines = [`Lead received through lead intake (delivery ${lead.external_id}).`];
  if (lead.business_name) lines.push(`Business: ${lead.business_name}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.notes) lines.push('', SENDER_NOTES_LABEL, lead.notes);
  return lines.join('\n');
}

/**
 * The owner's notice of a lead. The subject carries the first name only: subjects show
 * in notification previews, so the address stays in the body.
 */
export function leadNotification(
  lead: Lead,
  created: boolean,
  contactUrl: string | null,
): { subject: string; content: EmailContent } {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ');
  const details = [
    `Name: ${name}`,
    `Email: ${lead.email}`,
    ...(lead.phone ? [`Phone: ${lead.phone}`] : []),
    ...(lead.business_name ? [`Business: ${lead.business_name}`] : []),
    `Delivery: ${lead.external_id}`,
  ];
  return {
    subject: created ? `New lead: ${lead.first_name}` : `A lead you already have: ${lead.first_name}`,
    content: {
      preheader: created ? 'A new contact was added from lead intake.' : 'Lead intake sent someone already in your contacts.',
      blocks: [
        { kind: 'heading', text: created ? 'New lead' : 'A lead you already have' },
        {
          kind: 'paragraph',
          text: created
            ? 'Lead intake added a new contact with the status New.'
            : 'Lead intake sent someone already in your contacts. Their record is unchanged; the details are in a note on it.',
        },
        { kind: 'list', items: details },
        ...(lead.notes ? [{ kind: 'paragraph' as const, text: `${SENDER_NOTES_LABEL}\n${lead.notes}` }] : []),
        ...(contactUrl ? [{ kind: 'button' as const, label: 'Open the contact', url: contactUrl }] : []),
      ],
    },
  };
}
