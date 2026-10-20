import { subDays, subYears } from 'date-fns';
import { toISODate } from '@/lib/format';
import { addedAt } from './sections';

/**
 * The contacts Table tab: one sortable roster beside the sectioned list, with Sort,
 * Status and Added menus, a "N of M contacts in view" footer and the MRR total. Only
 * columns the CRM really holds.
 */

export type CrmTableSort = 'newest' | 'name' | 'mrr';
export type CrmTableAdded = 'any' | '30' | '90' | '12m';

export interface CrmTableFilters {
  sort: CrmTableSort;
  /** A status key, or 'any'. */
  status: string;
  added: CrmTableAdded;
}

export const DEFAULT_CRM_TABLE_FILTERS: CrmTableFilters = { sort: 'newest', status: 'any', added: 'any' };

export const CRM_TABLE_SORTS: ReadonlyArray<{ value: CrmTableSort; label: string }> = [
  { value: 'newest', label: 'Newest added' },
  { value: 'name', label: 'Name' },
  { value: 'mrr', label: 'MRR' },
];

export const CRM_TABLE_ADDED: ReadonlyArray<{ value: CrmTableAdded; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
];

/** Filters moved off their defaults; the sort is an order, not a filter. */
export function activeCrmTableFilterCount(f: CrmTableFilters): number {
  return [f.status !== 'any', f.added !== 'any'].filter(Boolean).length;
}

export interface CrmTableRow {
  id: string;
  status: string;
  first_name: string;
  last_name: string;
  submitted_at: string | null;
  created_at: string;
}

/** The first local calendar day inside an "Added" window. Twelve months is a calendar year, not 365 days. */
export function addedCutoff(added: CrmTableAdded, today: Date): string | null {
  if (added === 'any') return null;
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return toISODate(added === '12m' ? subYears(d, 1) : subDays(d, Number(added)));
}

function addedOn(row: CrmTableRow): string | null {
  const d = new Date(addedAt(row));
  return Number.isNaN(d.getTime()) ? null : toISODate(d);
}

function nameKey(row: CrmTableRow): string {
  return `${row.last_name}\u0000${row.first_name}`.toLowerCase();
}

/**
 * Filter then sort. `mrrOf` is the caller's revenue read (computeContactRevenue, the one
 * revenue path). Every sort breaks ties by name and then id, so equal rows never shuffle.
 */
export function crmTableRows<T extends CrmTableRow>(
  rows: readonly T[],
  filters: CrmTableFilters,
  opts: { today: Date; mrrOf: (row: T) => number | null },
): T[] {
  const cutoff = addedCutoff(filters.added, opts.today);
  const kept = rows.filter((r) => {
    if (filters.status !== 'any' && r.status !== filters.status) return false;
    if (cutoff) {
      const on = addedOn(r);
      if (!on || on < cutoff) return false;
    }
    return true;
  });
  const byName = (a: T, b: T) => nameKey(a).localeCompare(nameKey(b)) || a.id.localeCompare(b.id);
  const time = (r: T) => {
    const t = new Date(addedAt(r)).getTime();
    return Number.isNaN(t) ? -Infinity : t;
  };
  return kept.sort((a, b) => {
    switch (filters.sort) {
      case 'name':
        return byName(a, b);
      case 'mrr':
        return (opts.mrrOf(b) ?? -1) - (opts.mrrOf(a) ?? -1) || byName(a, b);
      default:
        return time(b) - time(a) || byName(a, b);
    }
  });
}

/** The MRR the table is showing: a no-value cell adds nothing. */
export function crmTableMrrTotal<T>(rows: readonly T[], mrrOf: (row: T) => number | null): number {
  return rows.reduce((sum, r) => sum + (mrrOf(r) ?? 0), 0);
}
