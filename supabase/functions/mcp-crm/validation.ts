// Pure validation for the mcp-crm tools. No Deno APIs, no clients, no Request objects:
// vitest imports this file as it is, and that is load-bearing.
//
// Ids are checked before they reach the database: a non-string id ({"a":1}) would
// otherwise stringify to "[object Object]", fail as a malformed uuid and come back as a
// generic -32603, a server-fault code for what is plainly a caller mistake. isUuid
// (_shared/http.ts) is the one id check.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The address bounds of contact_emails and contacts.email (3 to 254). Every address write
 * is mirrored into contact_emails by a trigger, so a longer address would pass a tool's own
 * check, pass the contacts write, and then fail the mirror's CHECK as a generic internal
 * error the caller could do nothing with.
 */
export const EMAIL_MIN_LEN = 3;
export const EMAIL_MAX_LEN = 254;

/**
 * Normalize and validate an address bound for contacts.email.
 *
 * Trims but deliberately does NOT lowercase: stored addresses keep the case they were given,
 * the local part is case-sensitive (RFC 5321), and every comparison that matters (the
 * contact_emails unique index, the duplicate check, the correction's compare-and-swap)
 * folds case itself. Lowercasing here would rewrite data on every call for no gain.
 *
 * The CR/LF refusal is redundant against EMAIL_RE today (its classes exclude both) and is
 * kept anyway: addresses reach mail headers, and a later loosening of the pattern must not
 * open header injection silently.
 */
export function normalizeEmail(v: unknown): { email: string } | { error: string } {
  if (typeof v !== 'string') return { error: 'email must be a string.' };
  const email = v.trim();
  if (email.length < EMAIL_MIN_LEN) return { error: 'email is required.' };
  if (email.length > EMAIL_MAX_LEN) return { error: `email must be ${EMAIL_MAX_LEN} characters or fewer.` };
  if (email.includes('\r') || email.includes('\n')) return { error: 'email must not contain line breaks.' };
  if (!EMAIL_RE.test(email)) return { error: 'email is not a valid address.' };
  return { email };
}

/**
 * The fields a model may set on a contact: the four base fields. Status, source, spouse
 * details, addresses and the client-since date are not writable by a model; the
 * connector's provenance lives in the audit log, not the lead source.
 */
export const CONTACT_BASE_WRITABLE = ['first_name', 'last_name', 'phone', 'business_name'] as const;
/** Creation may set the address. An update may not: an address is a routing control. */
export const CONTACT_CREATABLE = [...CONTACT_BASE_WRITABLE, 'email'] as const;
export const CONTACT_UPDATABLE = CONTACT_BASE_WRITABLE;

/** Iterates the ALLOWLIST, never the input, so an unknown key cannot land. null and undefined are absent. */
export function pickFrom(allow: readonly string[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allow) {
    if (Object.hasOwn(input, k) && input[k] !== undefined && input[k] !== null) out[k] = input[k];
  }
  return out;
}

/** An error string, or null when every value is a string of at most 5000 characters (and the address is one). */
export function validateContactPatch(p: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string') return `${k} must be a string`;
    if (v.length > 5000) return `${k} is too long`;
  }
  const email = p.email as string | undefined;
  if (email !== undefined && !EMAIL_RE.test(email)) return 'email is not a valid address';
  return null;
}

export const QUOTE_CADENCES = ['monthly', 'annual', 'one_time'] as const;
export const NOTE_KINDS = ['call', 'email', 'meeting', 'note'] as const;

/** The shape of a pick-list key (organization types, services, statuses). */
export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The largest amount numeric(15, 2) holds. */
export const MAX_AMOUNT = 9_999_999_999_999.99;

/**
 * A quote amount: a real number (typeof, never Number(): Number(true) is 1 and Number('')
 * is 0, both of which would pass a range check and become a figure), not negative, at most
 * two decimals, and within the column. The column's own bound, not a business-size cap.
 */
export function validateAmount(v: unknown): { amount: number } | { error: string } {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'amount must be a number' };
  if (v < 0) return { error: 'amount must not be negative' };
  if (v > MAX_AMOUNT) return { error: 'amount is too large' };
  const cents = v * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) return { error: 'amount must have at most two decimals' };
  return { amount: v };
}

/**
 * An optional id whose ABSENCE has a meaning (a quote with no business sits on the contact
 * itself). Presence, not truthiness: '' is falsy, and reading it as absent would book the
 * quote against the contact instead of the business the caller named. undefined and null
 * are absent; anything else must be a valid id.
 */
export function optionalId(v: unknown, isId: (v: unknown) => v is string): { id: string | null } | { error: true } {
  if (v === undefined || v === null) return { id: null };
  return isId(v) ? { id: v } : { error: true };
}
