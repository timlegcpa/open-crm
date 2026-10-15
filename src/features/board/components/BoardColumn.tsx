import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { BoardColumn as Column, LaneSort } from '../board';
import { stageTone } from '../stageTone';

/**
 * One lane: a recessed panel with a one-row header (dot, title, count, hint, add, menu) and
 * its cards, which scroll inside the lane, never the page. Every lane is the same surface;
 * the stage reads from the dot.
 */
export function BoardColumn({
  column,
  count,
  sortableCount,
  incoming = false,
  onAdd,
  onSort,
  onHide,
  children,
}: {
  column: Column;
  count: number;
  /**
   * Cards a sort would order: the WHOLE lane, not just the ones the toolbar filter leaves
   * visible, since a sort saves the whole lane.
   */
  sortableCount: number;
  /** A card from another lane is over one of this lane's cards (the cards are their own drop targets). */
  incoming?: boolean;
  onAdd: () => void;
  onSort: (by: LaneSort) => void;
  onHide: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage });
  const { title, hint } = column;

  return (
    <section
      ref={setNodeRef}
      aria-label={`${title}, ${count} ${count === 1 ? 'card' : 'cards'}`}
      // `basis-0` with `flex-1` keeps the lanes EQUAL and still: plain `flex-1` sizes each
      // lane from its content, so dragging a card out of one re-proportioned every lane
      // under the card being moved.
      className={cn(
        'flex min-h-[16rem] min-w-[13.5rem] flex-1 basis-0 snap-start flex-col gap-2 self-stretch rounded-lg border bg-lane px-2 pb-2 pt-1.5 transition-colors',
        isOver || incoming ? 'border-link/50' : 'border-border/60',
      )}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 px-1">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: stageTone(column.stage, column.colour).dot }} aria-hidden="true" />
        <h2 className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold text-foreground">{title}</h2>
        <span className="text-[12px] tabular-nums text-muted-foreground">{count}</span>
        <span className="ml-auto min-w-0 truncate text-[11.5px] text-muted-foreground">{hint}</span>
        <span className="-mr-1 flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={`Add work item to ${title}`} onClick={onAdd}>
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={`${title} options`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onAdd}>Add work item</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={sortableCount < 2} onSelect={() => onSort('priority')}>
                Sort by priority
              </DropdownMenuItem>
              <DropdownMenuItem disabled={sortableCount < 2} onSelect={() => onSort('due')}>
                Sort by due date
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onHide}>Hide lane</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>
      <ScrollArea fitWidth className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 pb-1 pr-1.5">
          {children}
          {/* The landing strip: without it a drop into an empty lane, or below the last
              card, has nothing to aim at. */}
          {isOver && <div aria-hidden="true" className="h-16 shrink-0 rounded-md border-2 border-dashed border-link/40 bg-link/5" />}
        </div>
      </ScrollArea>
    </section>
  );
}
