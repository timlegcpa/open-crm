import { useMemo } from 'react';
import type { LeadSource } from '@/api/pickLists';
import { Panel, TABLE_TH, TABLE_TH_NUM, TABLE_TR } from '@/components/layout/page';
import { ClickRegion } from '@/components/ui/click-region';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrencyShort, NO_VALUE_TEXT } from '@/lib/format';
import { cn } from '@/lib/utils';
import { leadsBySource, sourceValue, type MarketingContact } from '../lib/metrics';
import { sourceLabel, sourceSwatch } from '../sources';

interface SourceProps {
  contacts: readonly MarketingContact[];
  fromMonth: string;
  toMonth: string;
  rangeLabel: string;
  sourcesByKey: ReadonlyMap<string, LeadSource>;
}

/**
 * Leads that arrived in the range, by source, as one ranked bar each. Built from what was
 * COUNTED, so a source missing from the owner's list (or a system one) is never dropped from
 * the bars or the total; the table beside it draws the same cohort.
 */
export function LeadSourcesChart({ contacts, fromMonth, toMonth, rangeLabel, sourcesByKey }: SourceProps) {
  const data = useMemo(() => leadsBySource(contacts, fromMonth, toMonth), [contacts, fromMonth, toMonth]);
  const total = data.reduce((s, d) => s + d.leads, 0);
  const max = Math.max(1, ...data.map((d) => d.leads));
  return (
    <Panel
      title="Lead sources"
      action={
        <span className="text-xs text-muted-foreground">
          {rangeLabel} · <span className="font-medium tabular-nums text-foreground">{total} leads</span>
        </span>
      }
    >
      {data.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">No leads in this range.</p>
      ) : (
        <ul className="space-y-2.5 p-4" aria-label="Leads by source">
          {data.map((d) => {
            const label = sourceLabel(sourcesByKey, d.source);
            return (
              <li key={d.source} className="grid grid-cols-[minmax(0,120px)_1fr_40px] items-center gap-3 text-[13px]" title={`${label}: ${d.leads}`}>
                <span className="truncate text-foreground">{label}</span>
                <span className="h-3 rounded-r-sm" style={{ ...sourceSwatch(sourcesByKey, d.source), width: `${Math.max(2, (d.leads / max) * 100)}%` }} aria-hidden="true" />
                <span className="text-right font-medium tabular-nums text-foreground">{d.leads}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const money = (n: number) => (n > 0 ? formatCurrencyShort(n) : <span className="text-muted-foreground/50">{NO_VALUE_TEXT}</span>);

/**
 * What each source was worth in dollars, beside the leads it sent. The bars rank sources by
 * volume, which is the wrong ranking to buy against; this is the same cohort, priced.
 */
export function SourceValueTable({
  contacts,
  fromMonth,
  toMonth,
  rangeLabel,
  sourcesByKey,
  onSourceClick,
  selectedSource,
}: SourceProps & { onSourceClick?: (source: string) => void; selectedSource?: string | null }) {
  const rows = useMemo(() => sourceValue(contacts, fromMonth, toMonth), [contacts, fromMonth, toMonth]);
  // Summed from the rows drawn, never from a separately computed total.
  const totals = rows.reduce(
    (t, r) => ({ leads: t.leads + r.leads, wins: t.wins + r.wins, recurringARR: t.recurringARR + r.recurringARR, oneTime: t.oneTime + r.oneTime }),
    { leads: 0, wins: 0, recurringARR: 0, oneTime: 0 },
  );
  const totalPerLead = totals.leads > 0 ? Math.round((totals.recurringARR + totals.oneTime) / totals.leads) : 0;
  const dash = <span className="text-muted-foreground/50">{NO_VALUE_TEXT}</span>;

  return (
    <Panel title="What each source was worth" action={<span className="text-xs text-muted-foreground">{rangeLabel}</span>}>
      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">No leads arrived in this range.</p>
      ) : (
        <>
          <ScrollArea horizontal>
            <Table className="min-w-[560px] table-fixed text-[13px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={`${TABLE_TH} w-[26%]`}>Source</TableHead>
                  <TableHead className={`${TABLE_TH_NUM} w-[11%]`} title="Leads that arrived in this range.">Leads</TableHead>
                  <TableHead className={`${TABLE_TH_NUM} w-[11%]`} title="Of those leads, how many became a paying client, recurring or one-time.">Won</TableHead>
                  <TableHead className={`${TABLE_TH_NUM} w-[18%]`} title="Annual value of the recurring work those clients accepted: monthly fees x 12.">Recurring ARR</TableHead>
                  <TableHead className={`${TABLE_TH_NUM} w-[16%]`} title="One-time work those clients accepted. Never counted as recurring.">One-time</TableHead>
                  <TableHead className={`${TABLE_TH_NUM} w-[18%]`} title="Recurring ARR plus one-time, over leads. A blended figure, for ranking sources against each other.">$ / lead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const label = sourceLabel(sourcesByKey, r.source);
                  const name = (
                    <>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={sourceSwatch(sourcesByKey, r.source)} aria-hidden="true" />
                      <span className="truncate">{label}</span>
                    </>
                  );
                  return (
                    <TableRow key={r.source} className={cn(TABLE_TR, selectedSource === r.source && 'bg-muted/60')}>
                      <TableCell className="px-3 font-semibold text-foreground">
                        {onSourceClick ? (
                          <ClickRegion
                            onClick={() => onSourceClick(r.source)}
                            aria-pressed={selectedSource === r.source}
                            className="flex w-full min-w-0 items-center gap-2 hover:underline"
                          >
                            {name}
                          </ClickRegion>
                        ) : (
                          <span className="flex min-w-0 items-center gap-2">{name}</span>
                        )}
                      </TableCell>
                      <TableCell className="px-3 text-right tabular-nums text-muted-foreground">{r.leads || dash}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">{r.wins > 0 ? r.wins : dash}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">{money(r.recurringARR)}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums text-muted-foreground">{money(r.oneTime)}</TableCell>
                      <TableCell className="px-3 text-right font-semibold tabular-nums">{money(r.valuePerLead)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow className="font-semibold text-foreground" data-testid="source-total">
                  <TableCell className="px-3 py-2 text-[11px] uppercase tracking-wider">Range total</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{totals.leads || NO_VALUE_TEXT}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{totals.wins || NO_VALUE_TEXT}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{totals.recurringARR > 0 ? formatCurrencyShort(totals.recurringARR) : NO_VALUE_TEXT}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{totals.oneTime > 0 ? formatCurrencyShort(totals.oneTime) : NO_VALUE_TEXT}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{totalPerLead > 0 ? formatCurrencyShort(totalPerLead) : NO_VALUE_TEXT}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </ScrollArea>
          <div className="space-y-1 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              A cohort: the leads that arrived in this range, and the money the ones who signed brought with them. A client who
              arrived earlier and signed in this range is not counted here, so these wins will not match the Monthly table.
            </p>
            <p>Every figure is gross. Nothing here tracks a client leaving, so a source is never debited for one.</p>
          </div>
        </>
      )}
    </Panel>
  );
}
