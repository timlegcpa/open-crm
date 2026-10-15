import type { ReactNode } from 'react';
import { ClickRegion } from '@/components/ui/click-region';
import { ScrollArea } from '@/components/ui/scroll-area';
import { todayISODate } from '@/lib/format';
import { boardOverview, STAGE_HINTS, type BoardColumn, type BoardColumns } from '../board';
import { stageTone } from '../stageTone';
import { Figure } from './BoardFigures';

/**
 * The Overview tab: figures only, tiles then three bar lists. It reads the columns the board
 * draws, so the toolbar filter narrows both alike. A contact's row puts that contact in the
 * search and goes back to the board.
 */
export function BoardOverview({
  columns,
  board,
  onPickContact,
}: {
  columns: BoardColumns;
  board: readonly BoardColumn[];
  onPickContact: (name: string) => void;
}) {
  const o = boardOverview(columns, board, todayISODate());
  const stageMax = Math.max(1, ...o.byStage.map((s) => s.count));
  const contactMax = Math.max(1, ...o.byContact.map((c) => c.count));
  const priorityMax = Math.max(1, ...o.byPriority.map((p) => p.count));

  return (
    <ScrollArea fitWidth className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 pb-2">
        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card md:grid-cols-4">
          <Figure dot="hsl(var(--muted-foreground))" label="Open" value={o.open} hint={`${o.total} on the board`} />
          <Figure dot="hsl(var(--destructive))" label="Overdue" value={o.overdue} hint="Open, past due" />
          <Figure dot="hsl(var(--warning))" label="Due soon" value={o.dueSoon} hint="Open, due within a week" />
          <Figure dot="hsl(var(--success))" label="Done" value={o.done} hint={STAGE_HINTS.done} />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <BarPanel title="By stage">
            {o.byStage.map((s) => (
              <BarRow key={s.stage} label={s.title} count={s.count} max={stageMax} color={stageTone(s.stage, s.colour).dot} />
            ))}
          </BarPanel>

          <BarPanel title="Open by contact">
            {o.byContact.length === 0 ? (
              <p className="px-1 text-[12.5px] text-muted-foreground">No open cards with a contact.</p>
            ) : (
              o.byContact
                .slice(0, 10)
                .map((c) => (
                  <BarRow key={c.id} label={c.name} count={c.count} max={contactMax} color="hsl(var(--link))" onClick={() => onPickContact(c.name)} />
                ))
            )}
          </BarPanel>

          <BarPanel title="Open cards by priority">
            {o.byPriority.map((p) => (
              <BarRow
                key={p.value}
                label={p.label}
                count={p.count}
                max={priorityMax}
                color={p.value === 'urgent' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))'}
              />
            ))}
          </BarPanel>
        </div>
      </div>
    </ScrollArea>
  );
}

function BarPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <h3 className="px-1 text-[12.5px] font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

function BarRow({ label, count, max, color, onClick }: { label: string; count: number; max: number; color: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="w-[42%] min-w-0 truncate text-left text-[12.5px] text-foreground">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${Math.round((count / max) * 100)}%`, backgroundColor: color }} />
      </span>
      <span className="w-7 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">{count}</span>
    </>
  );
  return onClick ? (
    <ClickRegion onClick={onClick} className="flex h-7 items-center gap-3 rounded-md px-1 hover:bg-muted/60" aria-label={`${label}, ${count} open. Show on the board`}>
      {body}
    </ClickRegion>
  ) : (
    <div className="flex h-7 items-center gap-3 px-1">{body}</div>
  );
}
