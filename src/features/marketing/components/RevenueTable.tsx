import { Fragment, type CSSProperties } from 'react';
import type { ServiceType } from '@/api/pickLists';
import { Panel, TABLE_TH, TABLE_TR } from '@/components/layout/page';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrencyShort, NO_VALUE_TEXT } from '@/lib/format';
import type { UpsellProposed } from '@/lib/revenue';
import { sumServiceRows, type ServiceRevenueRow, type ServiceRevenueTotals } from '../lib/metrics';

const DIVIDER: CSSProperties = { borderLeft: '1px solid hsl(var(--border))' };
const NUM = 'px-3 text-right tabular-nums';

/** A money cell: the figure, or the muted no-value glyph for zero. */
function Money({ value, className }: { value: number; className?: string }) {
  if (!value) return <span className="text-muted-foreground/50">{NO_VALUE_TEXT}</span>;
  return <span className={className}>{formatCurrencyShort(value)}</span>;
}

/** The six money columns in render order. `tone` colours active green and proposed blue. */
function MoneyCells({ t, tone }: { t: ServiceRevenueTotals; tone?: boolean }) {
  const a = tone ? 'text-success-dark' : undefined;
  const p = tone ? 'text-link' : undefined;
  return (
    <>
      <TableCell className={NUM} style={DIVIDER}><Money value={t.mrr} className={a} /></TableCell>
      <TableCell className={NUM}><Money value={t.arr} className={a} /></TableCell>
      <TableCell className={NUM}><Money value={t.oneTime} className={tone ? 'text-warning-dark' : undefined} /></TableCell>
      <TableCell className={NUM} style={DIVIDER}><Money value={t.proposedMRR} className={p} /></TableCell>
      <TableCell className={NUM}><Money value={t.proposedARR} className={p} /></TableCell>
      <TableCell className={NUM}><Money value={t.proposedOneTime} className={p} /></TableCell>
    </>
  );
}

const FAMILY_TOTAL: Record<ServiceType['revenue_family'], string> = {
  recurring: 'Recurring services total',
  one_time: 'One-time services total',
};

/**
 * Revenue by service: one row per service type, a subtotal per revenue family, an Upsells
 * row, and a footer that is a tie-out. The footer is summed from the RENDERED rows, never
 * read from separate scalars, so it cannot silently disagree with the body.
 *
 * The money columns stay cadence-driven; the family only groups rows. So a one-time quote
 * on a recurring service shows in the One-time column of the recurring group. The Clients
 * column is deduped per contact per service and does NOT sum to the footer, which shows the
 * distinct recurring clients (one client can hold several services).
 */
export function RevenueTable({
  rows,
  serviceTypes,
  upsells,
  recurringClientsCount,
}: {
  rows: ServiceRevenueRow[];
  serviceTypes: ServiceType[];
  upsells: UpsellProposed;
  recurringClientsCount: number;
}) {
  const byKey = new Map(serviceTypes.map((s) => [s.key, s]));
  const families: { key: string; label?: string; rows: ServiceRevenueRow[] }[] = [
    ...(['recurring', 'one_time'] as const).map((family) => ({
      key: family,
      label: FAMILY_TOTAL[family],
      rows: rows.filter((r) => byKey.get(r.service)?.revenue_family === family),
    })),
    // A service no longer on the list still renders, ungrouped: no row is ever dropped.
    { key: 'unlisted', rows: rows.filter((r) => !byKey.has(r.service)) },
  ].filter((g) => g.rows.length > 0);

  const total = sumServiceRows(rows);
  // Upsells are proposed only: a won upsell has become a quote and is counted there.
  total.proposedMRR += upsells.proposedMRR;
  total.proposedARR += upsells.proposedARR;
  total.proposedOneTime += upsells.proposedOneTime;

  const hasUpsells = upsells.proposedMRR > 0 || upsells.proposedARR > 0 || upsells.proposedOneTime > 0;
  const isEmpty = rows.length === 0 && !hasUpsells;
  const foot = (n: number) => (n ? formatCurrencyShort(n) : NO_VALUE_TEXT);

  return (
    <Panel title="Revenue by service" action={<span className="text-xs text-muted-foreground">{recurringClientsCount} recurring clients</span>}>
      <ScrollArea horizontal>
        <Table className="min-w-[760px] table-fixed text-[13px]">
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: '9%' }} />
            {Array.from({ length: 6 }, (_, i) => <col key={i} style={{ width: '12%' }} />)}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={TABLE_TH} colSpan={2} />
              <TableHead className={`${TABLE_TH} text-center text-success-dark`} colSpan={3} style={DIVIDER}>Active</TableHead>
              <TableHead className={`${TABLE_TH} text-center text-link`} colSpan={3} style={DIVIDER}>Proposed</TableHead>
            </TableRow>
            <TableRow className="hover:bg-transparent">
              <TableHead className={TABLE_TH}>Service</TableHead>
              <TableHead className={`${TABLE_TH} text-right`} title="Active clients holding an accepted recurring quote for this service.">Clients</TableHead>
              <TableHead className={`${TABLE_TH} text-right`} style={DIVIDER}>MRR</TableHead>
              <TableHead className={`${TABLE_TH} text-right`}>ARR</TableHead>
              <TableHead className={`${TABLE_TH} text-right`} title="Accepted one-time quotes, plus every accepted quote on a one-time client.">One-time</TableHead>
              <TableHead className={`${TABLE_TH} text-right`} style={DIVIDER}>MRR</TableHead>
              <TableHead className={`${TABLE_TH} text-right`}>ARR</TableHead>
              <TableHead className={`${TABLE_TH} text-right`}>One-time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isEmpty ? (
              <TableRow>
                <TableCell colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No quotes yet.</TableCell>
              </TableRow>
            ) : (
              <>
                {families.map((g) => (
                  <Fragment key={g.key}>
                    {g.rows.map((r) => (
                      <TableRow key={r.service} className={TABLE_TR}>
                        <TableCell className="px-3 font-semibold text-foreground">{byKey.get(r.service)?.label ?? r.service}</TableCell>
                        <TableCell className={`${NUM} text-muted-foreground`}>
                          {r.clients || <span className="text-muted-foreground/50">{NO_VALUE_TEXT}</span>}
                        </TableCell>
                        <MoneyCells t={r} tone />
                      </TableRow>
                    ))}
                    {/* A lone service makes its own subtotal redundant. */}
                    {g.label && g.rows.length > 1 && (
                      <TableRow className={TABLE_TR}>
                        <TableCell className="px-3 text-[11px] font-semibold uppercase tracking-wider text-link">{g.label}</TableCell>
                        <TableCell className={`${NUM} text-muted-foreground/50`}>{NO_VALUE_TEXT}</TableCell>
                        <MoneyCells t={sumServiceRows(g.rows)} />
                      </TableRow>
                    )}
                  </Fragment>
                ))}
                {hasUpsells && (
                  <TableRow className={TABLE_TR}>
                    <TableCell className="px-3 font-semibold italic text-muted-foreground" title="Open and pitched add-ons, not yet quotes.">
                      Upsells
                    </TableCell>
                    <TableCell className={`${NUM} text-muted-foreground/50`}>{NO_VALUE_TEXT}</TableCell>
                    <MoneyCells t={{ mrr: 0, arr: 0, oneTime: 0, ...upsells }} tone />
                  </TableRow>
                )}
              </>
            )}
          </TableBody>
          <TableFooter>
            <TableRow className="font-semibold text-foreground" data-testid="revenue-total">
              <TableCell className="px-3 py-2 text-[11px] uppercase tracking-wider">Total</TableCell>
              <TableCell className={NUM}>{recurringClientsCount || NO_VALUE_TEXT}</TableCell>
              <TableCell className={NUM} style={DIVIDER}>{foot(total.mrr)}</TableCell>
              <TableCell className={NUM}>{foot(total.arr)}</TableCell>
              <TableCell className={NUM}>{foot(total.oneTime)}</TableCell>
              <TableCell className={NUM} style={DIVIDER}>{foot(total.proposedMRR)}</TableCell>
              <TableCell className={NUM}>{foot(total.proposedARR)}</TableCell>
              <TableCell className={NUM}>{foot(total.proposedOneTime)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </ScrollArea>
    </Panel>
  );
}
