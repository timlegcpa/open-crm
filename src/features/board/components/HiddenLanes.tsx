import { useDroppable } from '@dnd-kit/core';
import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BoardStageKey } from '../api';
import type { BoardColumn } from '../board';
import { stageTone } from '../stageTone';

/**
 * Where hidden lanes go: a narrow column at the right end of the board, one row per hidden
 * lane with its count and a Show button.
 *
 * Each row is a drop target whose id IS the stage, the same id the lane's own droppable
 * uses (the two are never mounted together), so a card dropped on a row takes the board's
 * ordinary cross-lane path: the reason dialog, then the bottom of that lane.
 */
export function HiddenLanes({
  columns,
  counts,
  onShow,
}: {
  /** The hidden lanes, in lane order. */
  columns: readonly BoardColumn[];
  counts: Record<BoardStageKey, number>;
  onShow: (stage: BoardStageKey) => void;
}) {
  return (
    <section
      aria-label="Hidden lanes"
      className="flex w-[11rem] shrink-0 snap-start flex-col gap-2 self-stretch rounded-lg border border-dashed border-border/70 px-2 pb-2 pt-1.5"
    >
      <h2 className="flex h-7 shrink-0 items-center px-1 text-[12.5px] font-semibold text-muted-foreground">Hidden</h2>
      {columns.map((col) => (
        <HiddenLaneRow key={col.stage} column={col} count={counts[col.stage]} onShow={() => onShow(col.stage)} />
      ))}
    </section>
  );
}

function HiddenLaneRow({ column, count, onShow }: { column: BoardColumn; count: number; onShow: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-9 items-center gap-2 rounded-md border bg-lane px-2 transition-colors',
        isOver ? 'border-link/50 bg-link/5' : 'border-border/60',
      )}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: stageTone(column.stage, column.colour).dot }} aria-hidden="true" />
      <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">{column.title}</span>
      <span className="text-[12px] tabular-nums text-muted-foreground">{count}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Show ${column.title}`}
        onClick={onShow}
      >
        <Eye />
      </Button>
    </div>
  );
}
