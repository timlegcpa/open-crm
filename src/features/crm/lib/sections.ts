import { CLIENT_LIKE_STATUSES, isClientLike, PIPELINE_STATUSES } from '@/lib/contactStatus';

/**
 * The index's lists. Clients holds paying contacts (recurring and one-time), Active
 * clients the recurring ones only (the Tiers tab ranks those), Leads every open stage plus
 * Cold. Former clients, signers and lost contacts show under All.
 */
export const CRM_LISTS = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'clients', label: 'Clients', statuses: [...CLIENT_LIKE_STATUSES] },
  { key: 'active', label: 'Active clients', statuses: ['client'] },
  { key: 'leads', label: 'Leads', statuses: [...PIPELINE_STATUSES] },
] as const satisfies ReadonlyArray<{ key: string; label: string; statuses: readonly string[] | null }>;

export type CrmListKey = (typeof CRM_LISTS)[number]['key'];

/** Whether a status shows under a list. */
export function statusInList(status: string, list: CrmListKey): boolean {
  const statuses = CRM_LISTS.find((l) => l.key === list)?.statuses ?? null;
  return statuses === null || (statuses as readonly string[]).includes(status);
}

/**
 * The contacts page's tabs, on the workspace's strip. Each names the list it ranks and what
 * the pane holds with no record open: the pipeline board, the tier rows, or the table.
 * Pipeline is the default. The tab lives in `?tab=` (a tab is a link) and the last one
 * chosen is remembered per browser for a bare /contacts. The lists that used to be tabs
 * (Clients, All) are the client panel's switch; an old `?tab=` naming one is not a tab,
 * so it falls back like any unknown value.
 *
 * The panel's search looks through everyone; Tiers ranks active clients only, so its rows
 * hold that during a search and a board filter.
 */
export const CRM_TABS = [
  { key: 'pipeline', label: 'Pipeline', list: 'leads', pane: 'board' },
  { key: 'tiers', label: 'Tiers', list: 'active', pane: 'tiers' },
  { key: 'table', label: 'Table', list: 'all', pane: 'table' },
] as const satisfies ReadonlyArray<{ key: string; label: string; list: CrmListKey; pane: 'board' | 'tiers' | 'table' }>;

export type CrmTabKey = (typeof CRM_TABS)[number]['key'];
export type CrmTab = (typeof CRM_TABS)[number];

export const DEFAULT_CRM_TAB: CrmTabKey = 'pipeline';

export function isCrmTabKey(value: unknown): value is CrmTabKey {
  return CRM_TABS.some((t) => t.key === value);
}

export function crmTab(key: CrmTabKey): CrmTab {
  return CRM_TABS.find((t) => t.key === key)!;
}

/** The tab to show: an explicit `?tab=` when it names one, else the remembered one, else Pipeline. */
export function resolveCrmTab(param: string | null, stored: unknown): CrmTabKey {
  if (isCrmTabKey(param)) return param;
  return isCrmTabKey(stored) ? stored : DEFAULT_CRM_TAB;
}

/**
 * When a contact was added: the backdated intake date when there is one, else the row's
 * creation. The board order, the table's sort and Added filter, the Overview and the CSV
 * all read this one helper.
 */
export function addedAt(c: { submitted_at: string | null; created_at: string }): string {
  return c.submitted_at ?? c.created_at;
}

/** A status's position: `contact_statuses.sort_order` from the database. */
export type StatusOrder = ReadonlyMap<string, { sort_order: number }>;

/**
 * `items` in the database's status order (`sort_order`). The grouping is the product's
 * (which statuses get a section or a column); the ORDER is the owner's, from the table. A
 * status the table has not loaded keeps its place in code order after the ordered ones.
 */
export function inStoredOrder<T>(items: readonly T[], statusOf: (item: T) => string, order: StatusOrder | undefined): T[] {
  const rank = (item: T) => order?.get(statusOf(item))?.sort_order ?? Number.POSITIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * The name an index row shows. Client-like contacts sort A-Z, so they read "Last, First";
 * everyone else reads naturally, falling back to the business, then the email.
 */
export function contactRowName(c: {
  status: string;
  first_name: string;
  last_name: string;
  full_name: string;
  business_name: string | null;
  email: string | null;
}): string {
  if (isClientLike(c.status) && c.last_name && c.first_name) return `${c.last_name}, ${c.first_name}`;
  return c.full_name || c.business_name || c.email || 'Unnamed contact';
}
