import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { formatDateShort } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BoardStage, BoardStageKey, WorkItem, WorkItemPatch, WorkItemType } from '../api';
import { cardContactName, cardDescription, latestNote, type BoardColumn, type BoardHistoryEvent } from '../board';
import { stageTone } from '../stageTone';
import { BoardHistoryList } from './BoardHistoryList';
import { WorkItemChips } from './WorkItemChips';

/** The surface a card face sits on: a 1px outline in its lane's colour, no shadow. */
export const CARD_SURFACE = 'rounded-md border bg-lane-card px-2.5 pb-[9px] pt-2.5';

/** The outline a card wears: its lane's colour, softened. */
export function cardBorderColor(item: WorkItem, stages: ReadonlyMap<string, BoardStage>): string {
  return stageTone(item.stage, stages.get(item.stage)?.colour).border;
}

/**
 * "2 notes · Sep 16", or "Added Sep 2" for a card nothing has happened to since it was
 * added. Events arrive newest first; the creation row is the "Added", never a note.
 */
export function cardMetaLabel(item: WorkItem, events: readonly BoardHistoryEvent[]): string {
  const since = events.filter((e) => e.kind !== 'created');
  if (since.length === 0) return `Added ${formatDateShort(item.created_at)}`;
  const notes = since.length === 1 ? '1 note' : `${since.length} notes`;
  return `${notes} · ${formatDateShort(since[0].at)}`;
}

/**
 * The last note, as a chip that hugs its text: the one authored sentence on a card. Two
 * spans: the outer takes the row's spare width so the meta stays right, the inner hugs the
 * words (one stretched chip read as an input, not as something someone wrote).
 */
function LastNote({ events }: { events: readonly BoardHistoryEvent[] }) {
  const note = latestNote(events);
  if (!note) return <span className="min-w-0 flex-1" />;
  return (
    <span className="min-w-0 flex-1">
      <span className="block w-fit max-w-full truncate rounded-sm bg-muted px-1.5 py-0.5 text-[11.5px] text-foreground" title={note}>
        {note}
      </span>
    </span>
  );
}

/**
 * The card face, drawn ONCE for the card in its lane and the copy in the user's hand, so a
 * card cannot change shape when it is picked up. `menu`, `meta` and `chips` are live in the
 * lane and plain in the overlay.
 */
export function BoardCardFace({
  item,
  events,
  types,
  today,
  menu,
  meta,
  chips,
}: {
  item: WorkItem;
  events: readonly BoardHistoryEvent[];
  types: ReadonlyMap<string, WorkItemType>;
  today: string;
  menu?: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
}) {
  const contact = cardContactName(item);
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{item.title}</span>
        <span className="flex shrink-0 items-center">
          {menu ?? <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
        </span>
      </div>
      {contact && <div className="truncate text-[12.5px] text-foreground">{contact}</div>}
      {chips ?? <WorkItemChips item={item} types={types} today={today} />}
      <div className="mt-[3px] flex min-w-0 items-center justify-between gap-2">
        <LastNote events={events} />
        {meta ?? <span className="shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{cardMetaLabel(item, events)}</span>}
      </div>
    </div>
  );
}

export function BoardCard({
  item,
  events,
  stages,
  columns,
  types,
  today,
  onOpenHistory,
  onMove,
  onChange,
  onArchive,
  onDelete,
}: {
  item: WorkItem;
  events: readonly BoardHistoryEvent[];
  stages: ReadonlyMap<string, BoardStage>;
  columns: readonly BoardColumn[];
  types: ReadonlyMap<string, WorkItemType>;
  today: string;
  onOpenHistory: () => void;
  onMove: (to: BoardStageKey) => void;
  onChange: (patch: WorkItemPatch) => void;
  /** The keep path. */
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({ id: item.id });
  const [preview, setPreview] = useState(false);
  // The card menu suppresses the preview: a hover timer started on the way to the menu
  // button used to fire with the menu open and cover Archive and Delete.
  const [menuOpen, setMenuOpen] = useState(false);
  const previewTimer = useRef<number | null>(null);
  const otherColumns = columns.filter((c) => c.stage !== item.stage);

  // A card with no history opens no preview (an empty one reads as something broken); the
  // click still opens the history dialog, where the first note gets written.
  const hasHistory = events.length > 0;
  const clearTimer = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
  };
  const openPreview = () => {
    if (!hasHistory || menuOpen) return;
    clearTimer();
    previewTimer.current = window.setTimeout(() => setPreview(true), 400);
  };
  const closePreview = () => {
    clearTimer();
    previewTimer.current = window.setTimeout(() => setPreview(false), 200);
  };
  const dropPreview = () => {
    clearTimer();
    setPreview(false);
  };
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (isDragging) setPreview(false);
  }, [isDragging]);

  const menu = (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) dropPreview();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          aria-label="Card actions"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {otherColumns.map((col) => (
          <DropdownMenuItem key={col.stage} onSelect={() => onMove(col.stage)}>
            Move to {col.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onArchive}>Archive</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const meta = (
    <Popover open={preview && !isDragging && !menuOpen}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto shrink-0 px-1 py-0 text-[11.5px] font-normal tabular-nums text-muted-foreground underline-offset-2 hover:bg-transparent hover:underline"
          aria-label={`History: ${cardMetaLabel(item, events)}`}
          onMouseEnter={openPreview}
          onMouseLeave={closePreview}
          onFocus={() => {
            if (hasHistory) setPreview(true);
          }}
          onBlur={() => setPreview(false)}
          onClick={(e) => {
            e.stopPropagation();
            onOpenHistory();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {cardMetaLabel(item, events)}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-72"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={openPreview}
        onMouseLeave={closePreview}
      >
        <BoardHistoryList events={events} rows={stages} compact />
      </PopoverContent>
    </Popover>
  );

  return (
    <div
      ref={setNodeRef}
      // The overlay is the card in the hand; the source stays behind as the hole it came
      // out of, and the sortable transform slides that hole (and the cards around it) to
      // where the card would land. Translate only, never scale: a lane mixes card heights.
      className={cn(
        'group relative transition-colors',
        CARD_SURFACE,
        isDragging ? 'bg-link/5 outline-dashed outline-1 -outline-offset-1 outline-link/40' : 'cursor-grab active:cursor-grabbing',
      )}
      // The hole shows only the dashed outline, never the colour of a card no longer there.
      style={{
        borderColor: isDragging ? 'transparent' : cardBorderColor(item, stages),
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      {...listeners}
      {...attributes}
      aria-roledescription="card"
      aria-label={cardDescription(item)}
      onMouseEnter={openPreview}
      onMouseLeave={closePreview}
      onClick={() => {
        if (!isDragging) onOpenHistory();
      }}
      // Composed, not replacing: the spread above carries the drag sensor's onKeyDown, and a
      // prop declared after it would shadow it. The sensor gets first refusal and signals it
      // took the key by preventing default.
      onKeyDown={(e) => {
        listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpenHistory();
        }
      }}
    >
      <div className={cn(isDragging && 'invisible')}>
        <BoardCardFace
          item={item}
          events={events}
          types={types}
          today={today}
          menu={menu}
          meta={meta}
          chips={<WorkItemChips item={item} types={types} today={today} onChange={onChange} onPickerOpen={dropPreview} />}
        />
      </div>
    </div>
  );
}
