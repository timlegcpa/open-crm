import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { queryKeys } from '@/api/queryKeys';
import {
  CONTACT_STATUSES,
  LEAD_SOURCES,
  listPickList,
  SERVICE_TYPES,
  type ContactStatus,
  type LeadSource,
  type PickListSpec,
  type ServiceType,
} from '@/api/pickLists';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import type { MarketingContact, MarketingQuote } from './lib/metrics';
import { isMonthKey } from './lib/months';

/**
 * The marketing page's reads and writes. Every read is keyset-paged on id, so no list is
 * ever cut short at PostgREST's 1,000-row cap, and every row is parsed at the boundary: a
 * column that changes shape fails here, loudly, instead of drawing a wrong figure.
 *
 * The three contact reads sit under the `contacts` key prefix, so every write that
 * invalidates `queryKeys.contacts.all` (a contact edit, a quote, an upsell, a delete)
 * refreshes the page's numbers with it. Goals have their own prefix: nothing else writes them.
 */
export const marketingKeys = {
  contacts: ['contacts', 'marketing', 'contacts'] as const,
  quotes: ['contacts', 'marketing', 'quotes'] as const,
  upsells: ['contacts', 'marketing', 'upsells'] as const,
  goals: ['marketing', 'goals'] as const,
  /**
   * Under the shared pick-list key, so a screen that edits a list (and invalidates
   * `queryKeys.pickLists.table`) refreshes this read too. Its own leaf, because its fetcher
   * pages where the shared one does not.
   */
  pickList: (table: string) => [...queryKeys.pickLists.table(table), 'marketing'] as const,
};

// PostgREST returns numeric(15,2) as a string; the math reads it through `num`.
const amount = z.union([z.number(), z.string()]).nullable();

// The contact columns the page reads, and nothing else: no address, phone or email.
const CONTACT_COLUMNS = 'id, created_at, submitted_at, full_name, business_name, status, source, client_since';

const contactRow = z.object({
  id: z.string(),
  created_at: z.string(),
  submitted_at: z.string().nullable(),
  full_name: z.string(),
  business_name: z.string().nullable(),
  status: z.string(),
  source: z.string(),
  client_since: z.string().nullable(),
});

const quoteRow = z.object({
  id: z.string(),
  contact_id: z.string(),
  service_type: z.string(),
  state: z.string(),
  cadence: z.string(),
  amount,
});

const upsellRow = z.object({
  id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  cadence: z.string(),
  est_amount: amount,
});

const goalRow = z.object({
  id: z.string(),
  month: z.string(),
  new_leads_target: z.number().nullable(),
  closed_clients_target: z.number().nullable(),
  ad_spend: amount,
});

export type MarketingContactRow = z.infer<typeof contactRow>;
export type QuoteRow = z.infer<typeof quoteRow>;
export type OpenUpsell = z.infer<typeof upsellRow>;
export type MonthlyGoal = z.infer<typeof goalRow>;

/** A contact with its quotes joined on: what the metrics read and the right bar edits. */
export interface PageContact extends MarketingContactRow, MarketingContact {
  contact_services: MarketingQuote[];
}

/** One table, every row, in pages of PAGE_SIZE ordered by id. */
function readAll<T extends { id: string }>(table: string, columns: string, schema: z.ZodType<T>, filter?: { column: string; values: string[] }) {
  return fetchAllPaged<T>(async (afterId) => {
    let query = getSupabase().from(table).select(columns).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (filter) query = query.in(filter.column, filter.values);
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query;
    if (error) return { data: null, error };
    return { data: z.array(schema).parse(data ?? []), error: null };
  });
}

export const listMarketingContacts = () => readAll('contacts', CONTACT_COLUMNS, contactRow);

export const listQuotes = () => readAll('contact_services', 'id, contact_id, service_type, state, cadence, amount', quoteRow);

/**
 * Upsells still being pitched. A `won` upsell has already become a quote (counted there)
 * and a `passed` one is dropped, so neither is read.
 */
export const listOpenUpsells = () =>
  readAll('contact_upsells', 'id, contact_id, status, cadence, est_amount', upsellRow, { column: 'status', values: ['open', 'pitched'] });

// ── Pick-lists, paged ──────────────────────────────────────────────────────────

const colour = z.string().nullable();
const leadSourceRow: z.ZodType<LeadSource> = z.object({
  key: z.string(), label: z.string(), colour, sort_order: z.number(), is_active: z.boolean(), is_system: z.boolean(),
});
const contactStatusRow: z.ZodType<ContactStatus> = z.object({
  key: z.string(), label: z.string(), colour, sort_order: z.number(),
});
const serviceTypeRow: z.ZodType<ServiceType> = z.object({
  key: z.string(), label: z.string(), colour, sort_order: z.number(), is_active: z.boolean(), is_system: z.boolean(),
  revenue_family: z.enum(['recurring', 'one_time']),
  default_cadence: z.enum(['monthly', 'annual', 'one_time']),
});

/** A shared pick-list (paged and in display order by listPickList), checked at the boundary. */
const readPickList = async <T extends { key: string }>(list: PickListSpec<T>, schema: z.ZodType<T>): Promise<T[]> =>
  z.array(schema).parse(await listPickList(list));

export const listLeadSources = () => readPickList(LEAD_SOURCES, leadSourceRow);
export const listContactStatuses = () => readPickList(CONTACT_STATUSES, contactStatusRow);
export const listServiceTypes = () => readPickList(SERVICE_TYPES, serviceTypeRow);

/** Every month's goals and spend, newest first. Never capped: All time spans 240 months. */
export async function listMonthlyGoals(): Promise<MonthlyGoal[]> {
  const rows = await readAll('monthly_goals', 'id, month, new_leads_target, closed_clients_target, ad_spend', goalRow);
  return rows.sort((a, b) => b.month.localeCompare(a.month));
}

/** Quotes joined onto their contacts, so the metrics keep their shape. A quote with no contact is dropped. */
export function joinQuotes(contacts: readonly MarketingContactRow[], quotes: readonly QuoteRow[]): PageContact[] {
  const byContact = new Map<string, MarketingQuote[]>();
  for (const q of quotes) {
    const list = byContact.get(q.contact_id);
    if (list) list.push(q);
    else byContact.set(q.contact_id, [q]);
  }
  return contacts.map((c) => ({ ...c, contact_services: byContact.get(c.id) ?? [] }));
}

// ── Goal writes ─────────────────────────────────────────────────────────────

/**
 * A new month. A column left out takes the table's default: NULL for a target ("no
 * target", never 0) and 0 for spend. The month is immutable once written.
 */
export interface NewMonthlyGoal {
  month: string;
  new_leads_target?: number | null;
  closed_clients_target?: number | null;
  ad_spend?: number;
}

/** What may change on an existing month. */
export type MonthlyGoalPatch = Partial<Pick<MonthlyGoal, 'new_leads_target' | 'closed_clients_target'>> & { ad_spend?: number };

const GOAL_PATCH_COLUMNS = ['new_leads_target', 'closed_clients_target', 'ad_spend'] as const;

function pickColumns<T extends object>(source: T, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(source, column)) out[column] = (source as Record<string, unknown>)[column];
  }
  return out;
}

export async function createMonthlyGoal(input: NewMonthlyGoal): Promise<void> {
  if (!isMonthKey(input.month)) throw new Error('Pick a month.');
  const row = { month: input.month, ...pickColumns(input, GOAL_PATCH_COLUMNS) };
  const { error } = await getSupabase().from('monthly_goals').insert(row).select('id');
  if (!error) return;
  // A month already on the list: the UNIQUE key, said in words.
  if ((error as { code?: string }).code === '23505') throw new Error('That month already has a row. Edit it instead.');
  throw error;
}

/** Writes only the columns present in `patch`; refuses a zero-row update. */
export async function updateMonthlyGoal(id: string, patch: MonthlyGoalPatch): Promise<void> {
  const payload = pickColumns(patch, GOAL_PATCH_COLUMNS);
  if (Object.keys(payload).length === 0) return;
  const { data, error } = await getSupabase().from('monthly_goals').update(payload).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This month was not saved. Reload and try again.');
}
