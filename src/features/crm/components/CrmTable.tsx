import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Contact } from '@/api/contacts';
import type { ContactStatus } from '@/api/pickLists';
import { StatusBadge } from '@/components/contacts/StatusBadge';
import { TABLE_TH, TABLE_TH_NUM } from '@/components/layout/page';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { links } from '@/features/links';
import { isTerminalStatus } from '@/lib/contactStatus';
import { formatCurrency, formatDate, NO_VALUE_TEXT } from '@/lib/format';
import { computeContactRevenue } from '@/lib/revenue';
import { addedAt, contactRowName } from '../lib/sections';
import {
  CRM_TABLE_ADDED,
  CRM_TABLE_SORTS,
  crmTableMrrTotal,
  crmTableRows,
  type CrmTableAdded,
  type CrmTableFilters,
  type CrmTableSort,
} from '../lib/table';

/** MRR as the table shows it: none on a terminal status, the one revenue path otherwise. */
export function tableMrrOf(c: Contact): number | null {
  return isTerminalStatus(c.status) ? null : computeContactRevenue(c).mrr;
}

/**
 * The Table view: Name, Status, Business (md+), MRR, Added (lg+), with Sort, Status and
 * Added menus and a footer saying how many of the contacts are in view and their MRR.
 */
export function CrmTable({
  contacts,
  total,
  filters,
  onFilters,
  statuses,
  businessOf,
  today,
}: {
  /** The contacts the search and view already let through. */
  contacts: readonly Contact[];
  /** Every contact, for "N of M". */
  total: number;
  filters: CrmTableFilters;
  onFilters: (next: CrmTableFilters) => void;
  statuses: readonly ContactStatus[];
  businessOf: (c: Contact) => string;
  today: Date;
}) {
  const rows = useMemo(() => crmTableRows(contacts, filters, { today, mrrOf: tableMrrOf }), [contacts, filters, today]);
  const statusByKey = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);
  const mrrTotal = crmTableMrrTotal(rows, tableMrrOf);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-4 md:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.sort} onValueChange={(v) => onFilters({ ...filters, sort: v as CrmTableSort })}>
          <SelectTrigger aria-label="Sort" className="h-8 w-[150px] text-[13px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CRM_TABLE_SORTS.map((o) => <SelectItem key={o.value} value={o.value} className="text-[13px]">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => onFilters({ ...filters, status: v })}>
          <SelectTrigger aria-label="Status filter" className="h-8 w-[150px] text-[13px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any" className="text-[13px]">Any status</SelectItem>
            {statuses.map((s) => <SelectItem key={s.key} value={s.key} className="text-[13px]">{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.added} onValueChange={(v) => onFilters({ ...filters, added: v as CrmTableAdded })}>
          <SelectTrigger aria-label="Added" className="h-8 w-[150px] text-[13px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CRM_TABLE_ADDED.map((o) => <SelectItem key={o.value} value={o.value} className="text-[13px]">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <ScrollArea className="min-h-0 flex-1" fitWidth>
          <table className="w-full table-fixed text-[13px]">
            <thead className="border-b border-border">
              <tr>
                <th className={TABLE_TH}>Name</th>
                <th className={`${TABLE_TH} w-[140px]`}>Status</th>
                <th className={`${TABLE_TH} hidden md:table-cell`}>Business</th>
                <th className={`${TABLE_TH_NUM} w-[100px]`}>MRR</th>
                <th className={`${TABLE_TH} hidden w-[120px] lg:table-cell`}>Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const mrr = tableMrrOf(c);
                return (
                  <tr key={c.id} className="border-b border-border last:border-b-0 hover:bg-muted/50 [&>td]:px-3 [&>td]:py-1.5">
                    <td className="truncate">
                      <Link to={links.contact(c.id)} className="font-medium underline-offset-2 hover:underline">
                        {contactRowName(c)}
                      </Link>
                    </td>
                    <td><StatusBadge statusKey={c.status} status={statusByKey.get(c.status)} /></td>
                    <td className="hidden truncate text-muted-foreground md:table-cell">{businessOf(c) || NO_VALUE_TEXT}</td>
                    <td className="text-right tabular-nums">{mrr ? formatCurrency(mrr, 0) : NO_VALUE_TEXT}</td>
                    <td className="hidden text-muted-foreground lg:table-cell">{formatDate(addedAt(c))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="py-8 text-center text-[13px] text-muted-foreground">No contacts match these filters.</p>}
        </ScrollArea>
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
          <span>
            {rows.length} of {total} contacts in view
          </span>
          <span className="tabular-nums">
            MRR <span className="font-semibold text-foreground">{formatCurrency(mrrTotal, 0)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
