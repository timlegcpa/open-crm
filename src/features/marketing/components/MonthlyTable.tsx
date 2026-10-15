import { TABLE_TH, TABLE_TH_NUM, TABLE_TR } from '@/components/layout/page';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrencyShort, NO_VALUE_TEXT } from '@/lib/format';
import type { MarketingTotals, MonthlyMarketingRow } from '../lib/metrics';

const muted = <span className="text-muted-foreground/50">{NO_VALUE_TEXT}</span>;
const money = (n: number) => (n > 0 ? formatCurrencyShort(n) : muted);

/**
 * An actual against its target, in one cell. A NULL target renders the actual alone: no
 * target is a different thing from a target of zero, and " / 0" would read as the latter.
 * Met only against a target above zero.
 */
export function ActualVsTarget({ actual, target }: { actual: number; target: number | null }) {
  const met = target != null && target > 0 && actual >= target;
  return (
    <>
      {actual > 0 ? <span className={met ? 'font-semibold text-success-dark' : undefined}>{actual}</span> : muted}
      {target != null && <span className="font-normal text-muted-foreground"> / {target}</span>}
    </>
  );
}

/** One row per month (events basis): spend, leads and wins against targets, cost per lead and per client. */
export function MonthlyTable({ rows, totals }: { rows: MonthlyMarketingRow[]; totals: MarketingTotals }) {
  const cell = 'px-3 text-right tabular-nums';
  return (
    <ScrollArea horizontal>
      <Table className="min-w-[620px] table-fixed text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={`${TABLE_TH} w-[18%]`}>Month</TableHead>
            <TableHead className={`${TABLE_TH_NUM} w-[13%]`} title="The month's ad spend. Change it with Edit ad spend.">Ad spend</TableHead>
            <TableHead className={`${TABLE_TH_NUM} w-[15%]`} title="Leads that arrived that month, against the month's target.">Leads / target</TableHead>
            <TableHead
              className={`${TABLE_TH_NUM} w-[15%]`}
              title="Clients won that month (client since in the month), whenever they first arrived, against the month's target. The source table counts the leads that arrived in the range instead, so its wins are a different number."
            >
              Won / target
            </TableHead>
            <TableHead className={`${TABLE_TH_NUM} w-[13%]`} title="Cost per lead: ad spend over leads.">CPL</TableHead>
            <TableHead className={`${TABLE_TH_NUM} w-[13%]`} title="Cost per acquisition: ad spend over clients won.">CAC</TableHead>
            <TableHead className={`${TABLE_TH_NUM} w-[13%]`} title="Clients won over leads.">Conv %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No months in this range.</TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.month} className={TABLE_TR}>
                <TableCell className="px-3 font-semibold text-foreground">{r.monthLabel}</TableCell>
                <TableCell className={cell}>{money(r.adSpend)}</TableCell>
                <TableCell className={cell}><ActualVsTarget actual={r.leads} target={r.newLeadsTarget} /></TableCell>
                <TableCell className={cell}><ActualVsTarget actual={r.closed} target={r.closedClientsTarget} /></TableCell>
                <TableCell className={`${cell} text-muted-foreground`}>{money(r.cpl)}</TableCell>
                <TableCell className={`${cell} text-muted-foreground`}>{money(r.cac)}</TableCell>
                <TableCell className={`${cell} text-muted-foreground`}>{r.convPct > 0 ? `${r.convPct}%` : muted}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
        {rows.length > 0 && (
          <TableFooter>
            <TableRow className="font-semibold text-foreground" data-testid="monthly-total">
              <TableCell className="px-3 py-2 text-[11px] uppercase tracking-wider">Range total</TableCell>
              <TableCell className={`${cell} py-2`}>{formatCurrencyShort(totals.adSpend)}</TableCell>
              <TableCell className={`${cell} py-2`}><ActualVsTarget actual={totals.leads} target={totals.leadsTarget} /></TableCell>
              <TableCell className={`${cell} py-2`}><ActualVsTarget actual={totals.closed} target={totals.closedTarget} /></TableCell>
              <TableCell className={`${cell} py-2`}>{money(totals.cpl)}</TableCell>
              <TableCell className={`${cell} py-2`}>{money(totals.cac)}</TableCell>
              <TableCell className={`${cell} py-2`}>{totals.convPct > 0 ? `${totals.convPct}%` : muted}</TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </ScrollArea>
  );
}
