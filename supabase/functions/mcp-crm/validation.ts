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
 * The fields a model may set on a contact. Creation takes the four base fields and the
 * address (plus a stage and a lead source, which create_contact checks against the
 * vocabulary itself). An update reaches the whole record but two things: the contact's own
 * address, which routes invitations and sign-in and has its own tool (correct_contact_email;
 * a portal sign-in moves only on the owner's record), and the stage, which moves only through set_contact_status,
 * compare-and-swapped. The client-since date is the status trigger's. The connector's
 * provenance lives in the audit log either way.
 */
export const CONTACT_BASE_WRITABLE = ['first_name', 'last_name', 'phone', 'business_name'] as const;
/** Creation may set the address. An update may not: an address is a routing control. */
export const CONTACT_CREATABLE = [...CONTACT_BASE_WRITABLE, 'email'] as const;
export const CONTACT_UPDATABLE = [
  ...CONTACT_BASE_WRITABLE,
  'spouse_first_name',
  'spouse_last_name',
  'spouse_email',
  'spouse_phone',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
  'source',
  'tier',
] as const;
/** The fields an update may clear. The names clear to empty; the source cannot be cleared. */
export const CONTACT_CLEARABLE: readonly string[] = CONTACT_UPDATABLE.filter((k) => k !== 'source');

/** contacts.tier's CHECK (0013). The app's twin is CLIENT_TIERS (a test holds them equal). */
export const CONTACT_TIERS = ['S', 'A', 'B', 'C', 'D', 'E'] as const;

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
  // An empty value clears a field, so only a non-empty one is held to a shape.
  const spouseEmail = p.spouse_email as string | undefined;
  if (spouseEmail && !EMAIL_RE.test(spouseEmail)) return 'spouse_email is not a valid address';
  const tier = p.tier as string | undefined;
  if (tier && !(CONTACT_TIERS as readonly string[]).includes(tier)) return `tier must be one of: ${CONTACT_TIERS.join(', ')}, or null to clear it`;
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

/**
 * The item kinds a request tool may compose: needs_items.kind's CHECK in 0005, all of it.
 * MCP_SENDABLE_KINDS is what the outward tools may send. A kind added to the table later
 * is neither composable nor sendable here until someone decides it can be read back to a
 * person meaningfully (a test holds the table's kinds inside the sendable set).
 */
export const REQUEST_ITEM_KINDS = ['document', 'question', 'todo', 'info'] as const;
export const MCP_SENDABLE_KINDS: readonly string[] = REQUEST_ITEM_KINDS;

export const MAX_REQUEST_ITEMS = 40;
export const MAX_REQUEST_TITLE = 200;
export const MAX_REQUEST_INTRO = 5000;
/** needs_items' own bounds. */
export const MAX_ITEM_LABEL = 500;
export const MAX_ITEM_DESCRIPTION = 2000;

/** One item as needs_replace_draft takes it. */
export interface RequestItemInput {
  kind: string;
  label: string;
  description: string | null;
  required: boolean;
  sensitive: boolean;
  category: string;
  tag: string;
  sort_order: number;
}

/**
 * The items of create_request and update_request, one parser for both, so the two doors
 * enforce the same rules. Supplied values are VALIDATED, never coerced: folding an unknown
 * category into general, or the string 'false' into required, would report success while
 * building a different request from the one read out loud. null means omitted (models
 * send an explicit null for an absent optional) and takes the default. Categories and
 * tags are the ACTIVE keys tools/list offered; the database checks again.
 */
export function parseRequestItems(
  raw: unknown,
  keys: { categories: readonly string[]; tags: readonly string[] },
): { items: RequestItemInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must list at least one item.' };
  if (raw.length > MAX_REQUEST_ITEMS) return { error: `items may list at most ${MAX_REQUEST_ITEMS} items.` };
  const items: RequestItemInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown> | null;
    const n = `Item ${i + 1}`;
    if (typeof it !== 'object' || it === null || Array.isArray(it)) return { error: `${n} must be an object.` };
    if (typeof it.label !== 'string' || !it.label.trim()) return { error: `${n} needs a label.` };
    const label = it.label.trim();
    if (label.length > MAX_ITEM_LABEL) return { error: `${n} label must be ${MAX_ITEM_LABEL} characters or fewer.` };
    const kind = it.kind ?? 'document';
    if (typeof kind !== 'string' || !(REQUEST_ITEM_KINDS as readonly string[]).includes(kind)) {
      return { error: `${n} kind must be one of: ${REQUEST_ITEM_KINDS.join(', ')}.` };
    }
    if (it.description != null && typeof it.description !== 'string') return { error: `${n} description must be text.` };
    const description = typeof it.description === 'string' && it.description.trim() ? it.description.trim() : null;
    if (description !== null && description.length > MAX_ITEM_DESCRIPTION) {
      return { error: `${n} description must be ${MAX_ITEM_DESCRIPTION} characters or fewer.` };
    }
    if (it.required != null && typeof it.required !== 'boolean') return { error: `${n} required must be true or false.` };
    if (it.sensitive != null && typeof it.sensitive !== 'boolean') return { error: `${n} sensitive must be true or false.` };
    const category = it.category ?? 'general';
    if (typeof category !== 'string' || !keys.categories.includes(category)) {
      return { error: `${n} category must be one of: ${keys.categories.join(', ')}.` };
    }
    const tag = it.tag ?? 'general';
    if (typeof tag !== 'string' || !keys.tags.includes(tag)) return { error: `${n} tag must be one of: ${keys.tags.join(', ')}.` };
    const sensitive = it.sensitive === true;
    // The table refuses this too; refusing here names the item instead of failing the batch.
    if (sensitive && kind !== 'question') {
      return {
        error: `${n} cannot be sensitive with kind '${kind}'. Only a question can be sensitive: it means the client's typed answer is stored encrypted. An uploaded file is encrypted already.`,
      };
    }
    items.push({ kind, label, description, required: it.required !== false, sensitive, category, tag, sort_order: i });
  }
  return { items };
}

/** A request's title and intro, as both draft tools take them. An absent or blank intro is none. */
export function parseRequestText(title: unknown, intro: unknown): { title: string; intro: string | null } | { error: string } {
  if (typeof title !== 'string' || !title.trim()) return { error: 'title is required.' };
  if (title.trim().length > MAX_REQUEST_TITLE) return { error: `title must be ${MAX_REQUEST_TITLE} characters or fewer.` };
  if (intro != null && typeof intro !== 'string') return { error: 'intro_message must be text.' };
  const text = typeof intro === 'string' ? intro.trim() : '';
  if (text.length > MAX_REQUEST_INTRO) return { error: `intro_message must be ${MAX_REQUEST_INTRO} characters or fewer.` };
  return { title: title.trim(), intro: text || null };
}

/** work_items.title's bound (0008). */
export const WORK_ITEM_TITLE_MAX = 200;
/** work_item_events_note_length: every board history note, a move's reason included. */
export const BOARD_NOTE_MAX = 2000;
/** work_items.priority's CHECK (0008). */
export const CARD_PRIORITIES = ['urgent', 'normal', 'low'] as const;

/**
 * A card's due date: YYYY-MM-DD that is a real calendar day, or null to clear it. The
 * calendar check matters: '2027-02-30' matches the pattern and would fail the ::date cast
 * in the database as a generic error the caller could do nothing with.
 */
export function parseBoardDate(v: unknown): { date: string | null } | { error: string } {
  if (v === null) return { date: null };
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'due_date must be YYYY-MM-DD, or null to clear it.' };
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: 'due_date is not a real calendar date.' };
  if (y < 2000 || y > 2100) return { error: 'due_date must fall between 2000 and 2100.' };
  return { date: v };
}

/** A board history note (or a move's reason): trimmed, required, within the database's cap. */
export function parseBoardNote(v: unknown, field = 'note'): { note: string } | { error: string } {
  const note = typeof v === 'string' ? v.trim() : '';
  if (!note) return { error: `${field} is required.` };
  if (note.length > BOARD_NOTE_MAX) return { error: `${field} must be ${BOARD_NOTE_MAX} characters or fewer.` };
  return { note };
}

/** A card's title: trimmed, required, within the column's bound. */
export function parseCardTitle(v: unknown): { title: string } | { error: string } {
  const title = typeof v === 'string' ? v.trim() : '';
  if (!title) return { error: 'title is required.' };
  if (title.length > WORK_ITEM_TITLE_MAX) return { error: `title must be ${WORK_ITEM_TITLE_MAX} characters or fewer.` };
  return { title };
}
