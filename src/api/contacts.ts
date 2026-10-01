import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { getErrorMessage } from '@/lib/errors';

/** What the list screen shows and searches. */
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
}

export interface Contact extends ContactListRow {
  updated_at: string;
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_name: string | null;
  spouse_email: string | null;
  spouse_phone: string | null;
  date_of_birth: string | null;
  spouse_date_of_birth: string | null;
  mailing_street: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  client_since: string | null;
}

/** The name to show for a contact: the person, else the business. */
export function contactDisplayName(c: Pick<ContactListRow, 'full_name' | 'business_name'>): string {
  return c.full_name || c.business_name || 'Unnamed contact';
}

const LIST_COLUMNS =
  'id, created_at, submitted_at, first_name, last_name, full_name, email, phone, business_name, status, source';

const DETAIL_COLUMNS =
  `${LIST_COLUMNS}, updated_at, spouse_first_name, spouse_last_name, spouse_name, spouse_email, ` +
  'spouse_phone, date_of_birth, spouse_date_of_birth, mailing_street, mailing_city, mailing_state, ' +
  'mailing_zip, client_since';

// Same pattern as supabase/functions/_shared/http.ts, so an id the browser accepts is
// never refused by an edge function. src/__tests__/edge/uuidParity.test.ts pins it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A route parameter is only ever put into a query once it is known to be a uuid. */
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Every contact, read in pages of 1,000 so the list is never silently cut short. */
export function listContacts(): Promise<ContactListRow[]> {
  return fetchAllPaged<ContactListRow>((afterId) => {
    let query = getSupabase()
      .from('contacts')
      .select(LIST_COLUMNS)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<ContactListRow[]>();
  });
}

/** One contact, or null when no such row exists (or it is not visible). */
export async function getContact(id: string): Promise<Contact | null> {
  const { data, error } = await getSupabase()
    .from('contacts')
    .select(DETAIL_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Contact | null) ?? null;
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

/** Creates a contact from the intake form and returns its id. */
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
 * The contact columns the Overview form may write. `email` and `spouse_email` are not
 * here: they mirror the default rows in contact_emails (a database trigger keeps both
 * in step), so they change only through the emails manager. `portal_sidebar_config`
 * is granted but has no screen yet.
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
  'date_of_birth',
  'spouse_date_of_birth',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
  'source',
  'status',
  'client_since',
] as const;

export type ContactPatchColumn = (typeof CONTACT_PATCH_COLUMNS)[number];
export type ContactPatch = Partial<Record<ContactPatchColumn, string | null>>;

/** Writes only the allow-listed columns present in `patch`. Nothing else can ride along. */
export async function updateContact(id: string, patch: ContactPatch): Promise<void> {
  const payload: ContactPatch = {};
  for (const column of CONTACT_PATCH_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) payload[column] = patch[column] ?? null;
  }
  if (Object.keys(payload).length === 0) return;
  const { data, error } = await getSupabase().from('contacts').update(payload).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This contact was not saved. It may have been deleted.');
}

/** Ids per request: a long `in.(...)` filter is a long URL. */
const BULK_CHUNK = 100;

export interface BulkStatusResult {
  requested: number;
  updated: number;
  /** Set when a request failed; earlier chunks may already have been written. */
  error: string | null;
}

/** Sets the status of many contacts. Writes `status` and nothing else. */
export async function bulkUpdateStatus(ids: string[], status: string): Promise<BulkStatusResult> {
  let updated = 0;
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const chunk = ids.slice(i, i + BULK_CHUNK);
    const { data, error } = await getSupabase()
      .from('contacts')
      .update({ status })
      .in('id', chunk)
      .select('id');
    if (error) return { requested: ids.length, updated, error: getErrorMessage(error, 'The status change failed.') };
    updated += data?.length ?? 0;
  }
  return { requested: ids.length, updated, error: null };
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
