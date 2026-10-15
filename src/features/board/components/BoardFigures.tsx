import { cn } from '@/lib/utils';
import { boardMix, type BoardColumn, type BoardColumns } from '../board';
import { stageTone } from '../stageTone';

/**
 * The figures strip above the board: one cell per lane (its dot, label, count and hint),
 * then the contacts the cards belong to. Figures, no prose. Every cell reads the same
 * filtered columns, so the strip is the filter's view of the board. On a phone the cells
 * wrap two to a row instead of scrolling the page sideways.
 */
export function BoardFigures({ columns, board }: { columns: BoardColumns; board: readonly BoardColumn[] }) {
  const mix = boardMix(columns);
  return (
    <div className="grid shrink-0 grid-cols-2 overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-5">
      {board.map((col) => (
        <Figure key={col.stage} dot={stageTone(col.stage, col.colour).dot} label={col.title} value={columns[col.stage].length} hint={col.hint} />
      ))}
      <Figure dot="hsl(var(--muted-foreground))" label="Contacts" value={mix.contacts} hint={`${mix.cards} ${mix.cards === 1 ? 'card' : 'cards'}`} />
    </div>
  );
}

export function Figure({ dot, label, value, hint, className }: { dot: string; label: string; value: number; hint: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 border-b border-r border-border/60 px-3 py-3 md:px-[18px] md:py-3.5', className)}>
      <div className="flex items-center gap-2">
        <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden="true" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      </div>
      <div className="text-[26px] font-semibold leading-none tabular-nums text-foreground">{value}</div>
      <div className="truncate text-[12px] text-muted-foreground">{hint}</div>
    </div>
  );
}
