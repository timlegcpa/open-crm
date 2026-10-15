import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { ClickRegion } from '@/components/ui/click-region';
import { cn } from '@/lib/utils';
import { sparkBarHeight } from '../lib/metrics';
import { monthShort } from '../lib/months';

/** Which list a fix or a source opens in the right bar. */
export type DrillKey = 'noPrice' | 'noSince' | `source:${string}`;

/** The figures the Overview chart can draw. Monthly recurring has no history, so it has no chart. */
export type MetricKey = 'leads' | 'won';

export interface MetricTile {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'good' | 'warn' | 'muted';
  /** Set on a tile that switches the chart; a tile without one is a plain figure. */
  metric?: MetricKey;
}

const SUB_TONE = { good: 'text-success', warn: 'text-warning-dark', muted: 'text-muted-foreground' } as const;

function TileBody({ tile }: { tile: MetricTile }) {
  return (
    <>
      <span className="block text-xs text-muted-foreground">{tile.label}</span>
      <span className="mt-1 block text-[26px] font-semibold leading-tight tabular-nums text-foreground">{tile.value}</span>
      <span className={cn('mt-0.5 block min-h-[18px] text-xs', SUB_TONE[tile.subTone ?? 'muted'])}>{tile.sub}</span>
    </>
  );
}

/** The big figures in one row. A tile with a metric switches the chart below to it. */
export function MetricTiles({ tiles, selected, onSelect }: { tiles: MetricTile[]; selected: MetricKey; onSelect: (key: MetricKey) => void }) {
  return (
    <div role="group" aria-label="Figures" className="grid grid-cols-1 border-b border-border sm:grid-cols-3">
      {tiles.map((t) =>
        t.metric ? (
          <ClickRegion
            key={t.label}
            onClick={() => onSelect(t.metric!)}
            aria-pressed={selected === t.metric}
            className={cn(
              'min-w-0 border-b-2 border-transparent px-4 py-4 hover:bg-muted/40',
              selected === t.metric && 'border-foreground bg-muted/60',
            )}
          >
            <TileBody tile={t} />
          </ClickRegion>
        ) : (
          <div key={t.label} className="min-w-0 border-b-2 border-transparent px-4 py-4">
            <TileBody tile={t} />
          </div>
        ),
      )}
    </div>
  );
}

export interface ChartBar {
  month: string;
  /** null = no data that month (no bar). */
  value: number | null;
}

/**
 * One series, twelve months, the value written above each bar. The current month (the
 * last bar) is drawn in the foreground colour; a zero is a 1px hairline so it never reads as
 * a small value, and a month with no data draws nothing.
 */
export function MetricChart({ title, bars }: { title: string; bars: ChartBar[] }) {
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0));
  return (
    <figure className="px-5 pb-3.5 pt-4" aria-label={title}>
      <figcaption>
        <span className="block text-[13px] font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">Last 12 months</span>
      </figcaption>
      <div className="mt-3.5 flex h-[200px] items-end gap-1 border-b border-border sm:gap-2.5">
        {bars.map((b, i) => {
          const h = sparkBarHeight(b.value, max);
          const last = i === bars.length - 1;
          return (
            <div
              key={b.month}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${monthShort(b.month)} ${b.month.slice(0, 4)}: ${b.value == null ? 'no data' : b.value}`}
            >
              {b.value != null && <span className="max-w-full truncate text-[10.5px] tabular-nums text-muted-foreground">{b.value}</span>}
              <div
                data-testid="chart-bar"
                className={cn('w-full rounded-t-sm', last ? 'bg-foreground' : 'bg-muted-foreground/40')}
                style={{ height: h == null ? 0 : h === 0 ? 1 : `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1 sm:gap-2.5" aria-hidden="true">
        {bars.map((b) => (
          <span key={b.month} className="min-w-0 flex-1 truncate text-center text-[10.5px] text-muted-foreground">
            {monthShort(b.month)}
          </span>
        ))}
      </div>
    </figure>
  );
}

export interface FixRow {
  key: DrillKey;
  count: number;
  label: string;
  why: string;
}

function CardHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3.5 pb-2.5 pt-3.5">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      {action}
    </div>
  );
}

/** The gaps that make the numbers wrong, one row each. A row opens its people in the right bar. */
export function ToFixPanel({ rows, active, onOpen }: { rows: FixRow[]; active: DrillKey | null; onOpen: (key: DrillKey) => void }) {
  const shown = rows.filter((r) => r.count > 0);
  return (
    <section aria-label="To fix" className="overflow-hidden rounded-lg border border-border bg-card">
      <CardHead title="To fix" sub="Gaps that make the numbers above wrong. Click one to fix it." />
      {shown.length === 0 && <p className="border-t border-border px-3.5 py-3 text-[13px] text-muted-foreground">Nothing to fix.</p>}
      {shown.map((r) => (
        <ClickRegion
          key={r.key}
          onClick={() => onOpen(r.key)}
          aria-pressed={active === r.key}
          className={cn('flex w-full items-center gap-3 border-t border-border px-3.5 py-3 hover:bg-muted/40', active === r.key && 'bg-muted/60')}
        >
          <span className="flex h-[22px] min-w-[28px] shrink-0 items-center justify-center rounded-full bg-warning-light px-1.5 text-xs font-semibold tabular-nums text-warning-dark">
            {r.count}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-foreground">{r.label}</span>
            <span className="block text-xs text-muted-foreground">{r.why}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </ClickRegion>
      ))}
    </section>
  );
}

export interface TopSourceRow {
  source: string;
  label: string;
  swatch: CSSProperties;
  leads: number;
  wins: number;
}

/** The top sources for the range: leads, won, and a small bar of leads. */
export function TopSourcesPanel({ rows, rangeLabel, onOpenTable }: { rows: TopSourceRow[]; rangeLabel: string; onOpenTable: () => void }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <section aria-label="Where clients came from" className="overflow-hidden rounded-lg border border-border bg-card">
      <CardHead
        title="Where clients came from"
        sub={rangeLabel}
        action={
          <ClickRegion onClick={onOpenTable} className="shrink-0 text-xs text-link hover:underline">
            Full table on Sources
          </ClickRegion>
        }
      />
      <div className="grid grid-cols-[1fr_60px_60px] border-t border-border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Source</span>
        <span className="text-right">Leads</span>
        <span className="text-right">Won</span>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-3.5 py-3 text-[13px] text-muted-foreground">No leads arrived in this range.</p>
      ) : (
        rows.map((r) => (
          <div key={r.source} className="grid grid-cols-[1fr_60px_60px] items-center border-t border-border px-3.5 py-2 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-1.5 shrink-0 rounded-sm" style={{ ...r.swatch, width: `${Math.max(4, Math.round((r.leads / max) * 40))}px` }} aria-hidden="true" />
              <span className="truncate text-foreground">{r.label}</span>
            </span>
            <span className="text-right tabular-nums text-muted-foreground">{r.leads}</span>
            <span className="text-right font-medium tabular-nums text-foreground">{r.wins}</span>
          </div>
        ))
      )}
    </section>
  );
}
