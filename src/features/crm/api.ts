import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { CONTACT_SERVICE_COLUMNS, type ContactService } from '@/api/contacts';

/**
 * The CRM's own reads and writes beyond the contact row itself: organizations, quotes
 * (`contact_services`), upsells, the activity log and the intake's audit row. Every write
 * returns the row it wrote (or says it reached none), so a caller never reports a save
 * that did not happen.
 */

// ── Errors ──────────────────────────────────────────────────────

interface DbError {
  code?: string;
  message?: string;
}

/** A Postgres unique violation on the quote key becomes a sentence; anything else passes through. */
function quoteError(error: unknown): unknown {
  if ((error as DbError | null)?.code === '23505') {
    return new Error('That service is already quoted for this person or business.');
  }
  return error;
}

/**
 * Every row of `table` for one contact, paged by id with the shared helper (a response
 * is capped at 1,000 rows and says nothing when it is), then shown oldest first with the
 * id as a stable tiebreak.
 */
async function allForContact<T extends { id: string; created_at: string }>(table: string, columns: string, contactId: string): Promise<T[]> {
  const rows = await fetchAllPaged<T>((afterId) => {
    let query = getSupabase().from(table).select(columns).eq('contact_id', contactId).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<T[]>();
  });
  return rows.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
}

function firstOrGone<T>(data: unknown, what: string): T {
  const rows = (data ?? []) as T[];
  if (rows.length === 0) throw new Error(`This ${what} was not saved. It may have been deleted.`);
  return rows[0];
}

// ── Organizations ───────────────────────────────────────────────

export const ORGANIZATION_STATUSES = ['prospect', 'active', 'paused', 'closed'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export interface Organization {
  id: string;
  contact_id: string;
  name: string;
  organization_type: string;
  tax_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * The slim row the board, the index search and the CSV read for every contact. No tax
 * ID: nothing on the roster shows one, so the roster never carries it.
 */
export interface RosterOrganization {
  id: string;
  contact_id: string;
  name: string;
  organization_type: string;
  status: string;
}

const ORGANIZATION_COLUMNS = 'id, contact_id, name, organization_type, tax_id, status, created_at, updated_at';
const ROSTER_COLUMNS = 'id, contact_id, name, organization_type, status';

export function listOrganizationsForContact(contactId: string): Promise<Organization[]> {
  return allForContact<Organization>('organizations', ORGANIZATION_COLUMNS, contactId);
}

/** Every organization, paged by id so the roster is never cut short at 1,000. */
export function listOrganizationRoster(): Promise<RosterOrganization[]> {
  return fetchAllPaged<RosterOrganization>((afterId) => {
    let query = getSupabase().from('organizations').select(ROSTER_COLUMNS).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<RosterOrganization[]>();
  });
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const { data, error } = await getSupabase().from('organizations').select(ORGANIZATION_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Organization | null) ?? null;
}

export interface NewOrganization {
  contact_id: string;
  name: string;
  organization_type: string;
  tax_id: string | null;
}

/** A new organization starts as a prospect. */
export async function createOrganization(input: NewOrganization): Promise<Organization> {
  const row = {
    contact_id: input.contact_id,
    name: input.name,
    organization_type: input.organization_type,
    tax_id: input.tax_id,
    status: 'prospect',
  };
  const { data, error } = await getSupabase().from('organizations').insert(row).select(ORGANIZATION_COLUMNS);
  if (error) throw error;
  return firstOrGone<Organization>(data, 'organization');
}

export interface OrganizationPatch {
  name?: string;
  organization_type?: string;
  tax_id?: string | null;
  status?: string;
}

/** Writes only the fields present in `patch`. */
export async function updateOrganization(id: string, patch: OrganizationPatch): Promise<Organization> {
  const payload: Record<string, unknown> = {};
  for (const key of ['name', 'organization_type', 'tax_id', 'status'] as const) {
    if (patch[key] !== undefined) payload[key] = patch[key];
  }
  if (Object.keys(payload).length === 0) throw new Error('Nothing to save.');
  const { data, error } = await getSupabase().from('organizations').update(payload).eq('id', id).select(ORGANIZATION_COLUMNS);
  if (error) throw error;
  return firstOrGone<Organization>(data, 'organization');
}

// ── Quote-driven status ─────────────────────────────────────────

/** A contact's stored status, read fresh (never the cache). Null when the contact is gone. */
export async function getContactStatus(contactId: string): Promise<string | null> {
  const { data, error } = await getSupabase().from('contacts').select('status').eq('id', contactId).maybeSingle();
  if (error) throw error;
  return (data as { status: string } | null)?.status ?? null;
}

/**
 * Moves a contact from `from` to `to` only if its stored status is still `from`
 * (compare-and-set). False when someone else changed it first: their move stands.
 */
export async function setStatusIfUnchanged(contactId: string, from: string, to: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('contacts')
    .update({ status: to })
    .eq('id', contactId)
    .eq('status', from)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

// ── Quotes (contact_services) ───────────────────────────────────

/**
 * One contact's quotes, straight from the table. Used ONLY by the quote write path to
 * derive the contact's status from server truth; screens render the list's embed.
 */
export function listServicesForContact(contactId: string): Promise<ContactService[]> {
  return allForContact<ContactService>('contact_services', CONTACT_SERVICE_COLUMNS, contactId);
}

export interface NewQuote {
  contact_id: string;
  organization_id: string | null;
  service_type: string;
  state: 'proposed' | 'accepted';
  cadence: 'monthly' | 'annual' | 'one_time';
  amount: number | null;
}

export async function createQuote(input: NewQuote): Promise<ContactService> {
  const row = {
    contact_id: input.contact_id,
    organization_id: input.organization_id,
    service_type: input.service_type,
    state: input.state,
    cadence: input.cadence,
    amount: input.amount,
  };
  const { data, error } = await getSupabase().from('contact_services').insert(row).select(CONTACT_SERVICE_COLUMNS);
  if (error) throw quoteError(error);
  return firstOrGone<ContactService>(data, 'quote');
}

/** Several quotes in one request (the intake's Services block). */
export async function createQuotes(rows: NewQuote[]): Promise<ContactService[]> {
  if (rows.length === 0) return [];
  const payload = rows.map((r) => ({
    contact_id: r.contact_id,
    organization_id: r.organization_id,
    service_type: r.service_type,
    state: r.state,
    cadence: r.cadence,
    amount: r.amount,
  }));
  const { data, error } = await getSupabase().from('contact_services').insert(payload).select(CONTACT_SERVICE_COLUMNS);
  if (error) throw quoteError(error);
  return (data ?? []) as ContactService[];
}

export type QuotePatch = Partial<Pick<NewQuote, 'state' | 'cadence' | 'amount' | 'organization_id'>>;

export async function updateQuote(id: string, patch: QuotePatch): Promise<ContactService> {
  const payload: Record<string, unknown> = {};
  for (const key of ['state', 'cadence', 'amount', 'organization_id'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) payload[key] = patch[key] ?? null;
  }
  if (Object.keys(payload).length === 0) throw new Error('Nothing to save.');
  const { data, error } = await getSupabase().from('contact_services').update(payload).eq('id', id).select(CONTACT_SERVICE_COLUMNS);
  if (error) throw quoteError(error);
  return firstOrGone<ContactService>(data, 'quote');
}

export async function deleteQuote(id: string): Promise<void> {
  const { data, error } = await getSupabase().from('contact_services').delete().eq('id', id).select('id');
  if (error) throw error;
  firstOrGone<{ id: string }>(data, 'quote');
}

// ── Upsells ─────────────────────────────────────────────────────

export const UPSELL_STATUSES = ['open', 'pitched', 'won', 'passed'] as const;
export type UpsellStatus = (typeof UPSELL_STATUSES)[number];

export interface ContactUpsell {
  id: string;
  contact_id: string;
  title: string;
  service_type: string | null;
  est_amount: number | string | null;
  cadence: 'monthly' | 'annual' | 'one_time';
  status: UpsellStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const UPSELL_COLUMNS = 'id, contact_id, title, service_type, est_amount, cadence, status, notes, created_at, updated_at';

export function listUpsells(contactId: string): Promise<ContactUpsell[]> {
  return allForContact<ContactUpsell>('contact_upsells', UPSELL_COLUMNS, contactId);
}

export interface NewUpsell {
  contact_id: string;
  title: string;
  service_type: string | null;
  est_amount: number | null;
  cadence: 'monthly' | 'annual' | 'one_time';
}

export async function createUpsell(input: NewUpsell): Promise<ContactUpsell> {
  const row = {
    contact_id: input.contact_id,
    title: input.title,
    service_type: input.service_type,
    est_amount: input.est_amount,
    cadence: input.cadence,
    status: 'open',
  };
  const { data, error } = await getSupabase().from('contact_upsells').insert(row).select(UPSELL_COLUMNS);
  if (error) throw error;
  return firstOrGone<ContactUpsell>(data, 'upsell');
}

export async function updateUpsell(id: string, patch: { status: UpsellStatus }): Promise<ContactUpsell> {
  const { data, error } = await getSupabase().from('contact_upsells').update({ status: patch.status }).eq('id', id).select(UPSELL_COLUMNS);
  if (error) throw error;
  return firstOrGone<ContactUpsell>(data, 'upsell');
}

export async function deleteUpsell(id: string): Promise<void> {
  const { data, error } = await getSupabase().from('contact_upsells').delete().eq('id', id).select('id');
  if (error) throw error;
  firstOrGone<{ id: string }>(data, 'upsell');
}

// ── Activity ────────────────────────────────────────────────────

export interface ActivityRow {
  id: string;
  contact_id: string;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export const ACTIVITY_PAGE = 50;

/** Where the previous page ended: its last row's (created_at, id). */
export type ActivityCursor = Pick<ActivityRow, 'created_at' | 'id'>;

/**
 * The filter for rows strictly older than `cursor` in (created_at desc, id desc) order:
 * earlier instants, or the same instant with a smaller id. Values are double-quoted, as
 * PostgREST requires for a timestamp's `:` and `+` inside a logic tree.
 */
export function activityAfter(cursor: ActivityCursor): string {
  return `created_at.lt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.lt."${cursor.id}")`;
}

/**
 * One page of a contact's activity, newest first, keyset-paged on (created_at, id): an
 * event written while the owner reads never shifts a page, so none repeats or is skipped.
 */
export async function listActivity(contactId: string, cursor: ActivityCursor | null): Promise<ActivityRow[]> {
  let query = getSupabase()
    .from('client_activity_log')
    .select('id, contact_id, action, details, created_at')
    .eq('contact_id', contactId);
  if (cursor) query = query.or(activityAfter(cursor));
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(ACTIVITY_PAGE);
  if (error) throw error;
  return (data ?? []) as ActivityRow[];
}

/** Pages flattened, each row once (by id), in page order. */
export function flattenActivity(pages: ReadonlyArray<readonly ActivityRow[]>): ActivityRow[] {
  const seen = new Set<string>();
  const out: ActivityRow[] = [];
  for (const row of pages.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

// ── Audit ───────────────────────────────────────────────────────

/**
 * Records that the owner created a contact. Fail-open: an audit row that cannot be written
 * never blocks or undoes the create; the console says so.
 */
export async function auditContactCreate(contactId: string): Promise<void> {
  try {
    const { data } = await getSupabase().auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return;
    const { error } = await getSupabase()
      .from('audit_logs')
      .insert({ user_id: userId, action: 'contact_create', details: { contact_id: contactId } });
    if (error) console.warn(`Audit row contact_create was not written: ${error.message}`);
  } catch (err) {
    console.warn('Audit row contact_create was not written', err);
  }
}

// ── Counts ──────────────────────────────────────────────────────

/**
 * How many working (not archived) contacts hold one of `statuses`: a head-only count, so no
 * row leaves the database. The shell's bottom bar reads it on every owner page, where the
 * whole contact list would be far too much to load for two numbers.
 */
export async function countContacts(statuses: readonly string[]): Promise<number> {
  const { count, error } = await getSupabase()
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .is('archived_at', null)
    .in('status', [...statuses]);
  if (error) throw error;
  return count ?? 0;
}
