import { isClientLike, PIPELINE_STATUSES, STORED_STATUSES, type ContactStatusKey } from '@/lib/contactStatus';

/**
 * The contact index's sections: ONE definition, read by every index that lists contacts.
 *
 * Every stored status belongs to exactly one section (sections.test.ts asserts it), because
 * a status with no section is filtered into nothing and its contacts stop appearing. That
 * includes the system status `esign_signer`: do not "clean up" its section.
 *
 * Each section holds one status, so its title is that status's label from
 * `contact_statuses` (the owner renames it there). Order and behaviour live here.
 */
export interface CrmSection {
  /** The status this section holds; also the section's key. */
  status: ContactStatusKey;
  /** Sort A-Z by last name instead of newest first. */
  alpha?: boolean;
  /** Collapsed by default, with the state remembered per browser. */
  collapsible?: boolean;
}

export const CRM_SECTIONS: readonly CrmSection[] = [
  { status: 'new_lead' },
  { status: 'active_lead' },
  { status: 'hot' },
  { status: 'warm' },
  { status: 'cold', collapsible: true },
  { status: 'client', alpha: true },
  { status: 'one_time', alpha: true, collapsible: true },
  { status: 'former_client', alpha: true, collapsible: true },
  { status: 'esign_signer', collapsible: true },
  { status: 'lost', collapsible: true },
];

/**
 * The index's list switch. Clients holds paying contacts only; Leads holds every open stage
 * plus Cold. Former clients, signers and lost contacts show under All.
 */
export const CRM_LISTS = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'clients', label: 'Clients', statuses: ['client', 'one_time'] },
  { key: 'leads', label: 'Leads', statuses: [...PIPELINE_STATUSES] },
] as const satisfies ReadonlyArray<{ key: string; label: string; statuses: readonly string[] | null }>;

export type CrmListKey = (typeof CRM_LISTS)[number]['key'];

export function isCrmListKey(value: unknown): value is CrmListKey {
  return CRM_LISTS.some((l) => l.key === value);
}

/** Whether a status shows under a list. */
export function statusInList(status: string, list: CrmListKey): boolean {
  const statuses = CRM_LISTS.find((l) => l.key === list)?.statuses ?? null;
  return statuses === null || (statuses as readonly string[]).includes(status);
}

/**
 * When a contact was added: the backdated intake date when there is one, else the row's
 * creation. The board order, the table's sort and Added filter, the Overview and the CSV
 * all read this one helper.
 */
export function addedAt(c: { submitted_at: string | null; created_at: string }): string {
  return c.submitted_at ?? c.created_at;
}

function addedTime(c: { submitted_at: string | null; created_at: string }): number {
  const t = new Date(addedAt(c)).getTime();
  return Number.isNaN(t) ? 0 : t;
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
 * Contacts bucketed into the sections above, in the database's status order, each sorted the way its section asks. Callers
 * filter first; this takes the rows that survived. The id breaks every tie, so the order
 * never shuffles between renders.
 */
export function bucketBySection<
  T extends { id: string; status: string; first_name: string; last_name: string; submitted_at: string | null; created_at: string },
>(contacts: readonly T[], order?: StatusOrder): Array<CrmSection & { rows: T[] }> {
  const byStatus = new Map<string, T[]>();
  for (const c of contacts) {
    const list = byStatus.get(c.status) ?? [];
    list.push(c);
    byStatus.set(c.status, list);
  }
  return inStoredOrder(CRM_SECTIONS, (s) => s.status, order).map((s) => {
    const rows = [...(byStatus.get(s.status) ?? [])];
    rows.sort((a, b) =>
      s.alpha
        ? a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) || a.id.localeCompare(b.id)
        : addedTime(b) - addedTime(a) || a.id.localeCompare(b.id),
    );
    return { ...s, rows };
  });
}

/** Statuses no section holds. Empty by construction; sections.test.ts keeps it so. */
export function statusesWithoutSection(): string[] {
  const held = new Set(CRM_SECTIONS.map((s) => s.status));
  return STORED_STATUSES.filter((s) => !held.has(s));
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
