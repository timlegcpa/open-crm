import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { getErrorMessage } from '@/lib/errors';

/** What a contact list, a picker and a search read. Every contact row carries at least this. */
export interface ContactListRow {
  id: string;
  created_at: string;
  submitted_at: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  business_name: string | null;
  status: string;
  source: string;
  /**
   * When the contact was archived (taken off every working list, record kept), else null.
   * A second axis beside the status, which archiving leaves alone: see isArchived. Every
   * list read selects it; optional so a row built by hand (a fixture) may leave it out.
   */
  archived_at?: string | null;
}

/**
 * A quote: one `contact_services` row per (contact, organization or none, service type).
 * PostgREST returns numeric(15,2) as a string, so `amount` is read through `num` or
 * `toAmount`, never used as a number directly. NULL (and 0) means no price agreed yet.
 */
export interface ContactService {
  id: string;
  contact_id: string;
  organization_id: string | null;
  service_type: string;
  state: 'proposed' | 'accepted';
  cadence: 'monthly' | 'annual' | 'one_time';
  amount: number | string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A contact as every CRM screen holds it: the whole row the owner may see plus its quotes.
 * The list carries the quotes because the board, the table's MRR, the pipeline figures, the
 * right bar and the CSV all read them; a write returns the same shape, so merging it into
 * the cached list never strips the quotes off a card.
 */
export interface Contact extends ContactListRow {
  updated_at: string;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_name: string | null;
  spouse_email: string | null;
  spouse_phone: string | null;
  mailing_street: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  client_since: string | null;
  /** The owner's hand-set client ranking (src/features/crm/lib/tiers.ts); null = not ranked. */
  tier: string | null;
  contact_services: ContactService[];
}

/**
 * Whether a contact is archived: off the index, the pipeline board, the table, the tiers,
 * every contact picker and group email, while its record stays whole and reachable. Every
 * working list filters with this one predicate, never its own reading of the column.
 */
export function isArchived(c: { archived_at?: string | null }): boolean {
  return c.archived_at != null;
}

/** The name to show for a contact: the person, else the business. */
export function contactDisplayName(c: Pick<ContactListRow, 'full_name' | 'business_name'>): string {
  return c.full_name || c.business_name || 'Unnamed contact';
}

export const CONTACT_SERVICE_COLUMNS =
  'id, contact_id, organization_id, service_type, state, cadence, amount, created_at, updated_at';

/**
 * Every column a CRM screen reads, and the quotes. Named, never `*`: a column added to the
 * table later (a server-only one) does not reach the browser by default.
 */
const CONTACT_COLUMNS =
  'id, created_at, updated_at, submitted_at, first_name, last_name, full_name, email, phone, business_name, ' +
  'spouse_first_name, spouse_last_name, spouse_name, spouse_email, spouse_phone, mailing_street, mailing_city, ' +
  `mailing_state, mailing_zip, status, source, client_since, tier, archived_at, contact_services(${CONTACT_SERVICE_COLUMNS})`;

// Same pattern as supabase/functions/_shared/http.ts, so an id the browser accepts is
// never refused by an edge function. src/__tests__/edge/uuidParity.test.ts pins it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A route parameter is only ever put into a query once it is known to be a uuid. */
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A contact with no quotes has an empty array, never a missing one. */
function withQuotes(row: Contact): Contact {
  return Array.isArray(row.contact_services) ? row : { ...row, contact_services: [] };
}

/** Every contact with its quotes, read in pages of 1,000 so the list is never silently cut short. */
export async function listContacts(): Promise<Contact[]> {
  const rows = await fetchAllPaged<Contact>((afterId) => {
    let query = getSupabase()
      .from('contacts')
      .select(CONTACT_COLUMNS)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<Contact[]>();
  });
  return rows.map(withQuotes);
}

/** One contact with its quotes, or null when it does not exist or is not visible. */
export async function getContact(id: string): Promise<Contact | null> {
  const { data, error } = await getSupabase()
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('id', id)
    .returns<Contact[]>()
    .maybeSingle();
  if (error) throw error;
  return data ? withQuotes(data) : null;
}

export interface NewContact {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  business_name: string | null;
  status: string;
  source: string;
  submitted_at: string | null;
}

/**
 * Creates a contact from the intake and returns its id. Never sends `status_history`
 * (the database writes it), `full_name` (generated) or `client_since` (the database
 * stamps it, as a UTC day, when a contact is entered as a client).
 */
export async function createContact(input: NewContact): Promise<string> {
  const row = {
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone,
    business_name: input.business_name,
    status: input.status,
    source: input.source,
    submitted_at: input.submitted_at,
  };
  const { data, error } = await getSupabase().from('contacts').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * The contact columns the CRM may write. `email` and `spouse_email` are not here: they
 * mirror the default rows in contact_emails (a database trigger keeps both in step), so
 * they change only through the emails manager. `status_history` (trigger-owned),
 * `full_name` and `spouse_name` (generated) are never written. `portal_sidebar_config`
 * belongs to the portal's own panel.
 */
export const CONTACT_PATCH_COLUMNS = [
  'submitted_at',
  'first_name',
  'last_name',
  'phone',
  'business_name',
  'spouse_first_name',
  'spouse_last_name',
  'spouse_phone',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
  'source',
  'status',
  'client_since',
  'tier',
  'archived_at',
] as const;

export type ContactPatchColumn = (typeof CONTACT_PATCH_COLUMNS)[number];
export type ContactPatch = Partial<Record<ContactPatchColumn, string | null>>;

/** NOT NULL with a '' default in the table: cleared means '', never null. */
const NAME_COLUMNS: ReadonlySet<string> = new Set(['first_name', 'last_name']);

/**
 * The payload a patch becomes: allow-listed columns only, and a cleared field ('') stored
 * as null, so a nullable text column never holds an empty string and a cleared date never
 * fails as ''. The two name columns keep ''.
 */
export function contactPatchPayload(patch: ContactPatch): ContactPatch {
  const payload: ContactPatch = {};
  for (const column of CONTACT_PATCH_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
    const value = patch[column];
    payload[column] = NAME_COLUMNS.has(column) ? (value ?? '') : value === '' || value == null ? null : value;
  }
  return payload;
}

/**
 * Writes the allow-listed columns present in `patch` and returns the saved row, quotes
 * included, for the caller to merge into the cached list.
 */
export async function updateContact(id: string, patch: ContactPatch): Promise<Contact> {
  const payload = contactPatchPayload(patch);
  if (Object.keys(payload).length === 0) throw new Error('Nothing to save.');
  const { data, error } = await getSupabase().from('contacts').update(payload).eq('id', id).select(CONTACT_COLUMNS);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Contact[];
  if (rows.length === 0) throw new Error('This contact was not saved. It may have been deleted.');
  return withQuotes(rows[0]);
}

/** Ids per request: a long `in.(...)` filter is a long URL. */
const BULK_CHUNK = 100;

export interface BulkStatusResult {
  requested: number;
  /** Contacts the server says it wrote. */
  updated: number;
  /** Every selected id the server did not return as written (refused, gone, or never sent after a failure). */
  failedIds: string[];
  /** Set when a request failed; earlier chunks may already have been written. */
  error: string | null;
}

/**
 * One write to many contacts. Every selected row is written, whatever the cache says, and
 * only the ids the server returns count as updated: a row that is gone or out of reach
 * comes back as failed, so the caller keeps it selected for a retry.
 */
async function bulkUpdate(ids: readonly string[], values: ContactPatch, failure: string): Promise<BulkStatusResult> {
  const written = new Set<string>();
  let error: string | null = null;
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const chunk = ids.slice(i, i + BULK_CHUNK);
    const result = await getSupabase().from('contacts').update(values).in('id', chunk).select('id');
    if (result.error) {
      error = getErrorMessage(result.error, failure);
      break;
    }
    for (const row of (result.data ?? []) as Array<{ id: string }>) written.add(row.id);
  }
  const failedIds = ids.filter((id) => !written.has(id));
  if (!error && failedIds.length > 0) error = 'Some contacts were not changed. They may have been deleted.';
  return { requested: ids.length, updated: ids.length - failedIds.length, failedIds, error };
}

/**
 * Sets the status of many contacts. A row already at the target gets no new history entry
 * (the database records history only on a change). client_since is the database's to
 * stamp (see statusChangePatch).
 */
export function bulkUpdateStatus(ids: readonly string[], status: string): Promise<BulkStatusResult> {
  return bulkUpdate(ids, { status }, 'The status change failed.');
}

/**
 * Archives (or restores) many contacts. The status is not touched, so a restored contact is
 * back at the stage it left. The database stamps the archive time itself; the value sent
 * only says "archived".
 */
export function bulkSetArchived(ids: readonly string[], archived: boolean): Promise<BulkStatusResult> {
  return bulkUpdate(ids, { archived_at: archived ? new Date().toISOString() : null }, archived ? 'The archive failed.' : 'The restore failed.');
}

const DELETE_IN_PROGRESS_MESSAGE = 'This contact is already being deleted. Try again in a moment.';
const DELETE_FALLBACK_MESSAGE = 'Could not delete this contact.';

/** The server's JSON body on a non-2xx answer lives on `error.context` (a Response). */
async function deleteErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context as
    | { status?: unknown; json?: unknown }
    | undefined;
  if (context && typeof context.json === 'function') {
    let body: unknown = null;
    try {
      body = await (context.json as () => Promise<unknown>)();
    } catch {
      body = null;
    }
    // A machine code on 409 only; on every other status it is a sentence for the owner.
    const serverError = (body as { error?: unknown } | null)?.error;
    if (context.status === 409 || serverError === 'delete_in_progress') return DELETE_IN_PROGRESS_MESSAGE;
    if (typeof serverError === 'string' && serverError.length > 0) return serverError;
    return DELETE_FALLBACK_MESSAGE;
  }
  return getErrorMessage(error, DELETE_FALLBACK_MESSAGE);
}

/**
 * Deletes a contact through the `delete-contact` edge function, which owns the delete
 * protocol. The browser never deletes a contact row itself.
 */
export async function deleteContact(id: string): Promise<{ alreadyGone: boolean }> {
  const { data, error } = await getSupabase().functions.invoke('delete-contact', {
    body: { contact_id: id },
  });
  if (error) throw new Error(await deleteErrorMessage(error));
  const body = data as { deleted?: unknown; already_gone?: unknown } | null;
  if (body?.deleted !== true) throw new Error('The server did not confirm the delete.');
  return { alreadyGone: body.already_gone === true };
}

export type DeleteOutcome =
  | { id: string; ok: true; alreadyGone: boolean }
  | { id: string; ok: false; error: string };

/** One edge-function call per contact, in order. Each outcome is reported on its own. */
export async function deleteContacts(ids: string[]): Promise<DeleteOutcome[]> {
  const outcomes: DeleteOutcome[] = [];
  for (const id of ids) {
    try {
      const { alreadyGone } = await deleteContact(id);
      outcomes.push({ id, ok: true, alreadyGone });
    } catch (err) {
      outcomes.push({ id, ok: false, error: getErrorMessage(err, DELETE_FALLBACK_MESSAGE) });
    }
  }
  return outcomes;
}
