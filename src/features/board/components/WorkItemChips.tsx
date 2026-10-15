import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { CalendarDays, Flag, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDate, parseDateOnly, toISODate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkItem, WorkItemPatch, WorkItemPriority, WorkItemType } from '../api';
import { priorityLabel, WORK_ITEM_PRIORITIES, workItemDue, type DueState } from '../board';

/**
 * A card's type, priority and due-date chips. Static on the copy in the user's hand while
 * dragging; interactive in the lane, where each chip opens its own picker.
 *
 * Every trigger and every picker stops click, pointerdown AND keydown. A portalled picker
 * leaves the DOM but not the React tree, so its events still bubble to the card: a click
 * would open the history, Enter would too, and Space would pick the card up to drag.
 */

const PRIORITY_TONE: Record<WorkItemPriority, string> = {
  urgent: 'text-destructive',
  normal: 'text-muted-foreground',
  low: 'text-muted-foreground/60',
};

const DUE_TONE: Record<DueState, string> = {
  overdue: 'text-destructive',
  today: 'text-warning',
  soon: 'text-warning',
  later: 'text-muted-foreground',
  done: 'text-muted-foreground',
};

const CHIP =
  'inline-flex h-5 items-center gap-1 rounded-sm border border-border/70 bg-transparent px-1.5 text-[11px] font-medium tabular-nums text-foreground shadow-none [&_svg]:size-3';

const stop = (e: SyntheticEvent) => e.stopPropagation();
const STOP = { onClick: stop, onPointerDown: stop, onKeyDown: stop };

type ChipItem = Pick<WorkItem, 'priority' | 'due_date' | 'stage' | 'work_item_type'>;

function typeLabel(key: string, types: ReadonlyMap<string, WorkItemType>): string {
  return types.get(key)?.label ?? key;
}

function DueFace({ item, today }: { item: ChipItem; today: string }) {
  const due = workItemDue(item, today);
  return (
    <span className={cn('inline-flex items-center gap-1', due ? DUE_TONE[due.state] : 'text-muted-foreground')}>
      <CalendarDays aria-hidden="true" />
      {due ? due.label : 'No date'}
    </span>
  );
}

export function WorkItemChips({
  item,
  types,
  today,
  onChange,
  onPickerOpen,
}: {
  item: ChipItem;
  types: ReadonlyMap<string, WorkItemType>;
  /** The viewer's local today, 'YYYY-MM-DD'. */
  today: string;
  /** Absent on the drag overlay, which draws the chips as plain text. */
  onChange?: (patch: WorkItemPatch) => void;
  /** Fired when a picker opens, so the card can drop its hover preview (the two would stack). */
  onPickerOpen?: () => void;
}) {
  if (!onChange) {
    return (
      <ChipRow>
        <span className={CHIP}>
          <Tag className="text-muted-foreground" aria-hidden="true" />
          {typeLabel(item.work_item_type, types)}
        </span>
        <span className={CHIP}>
          <Flag className={PRIORITY_TONE[item.priority]} aria-hidden="true" />
          {priorityLabel(item.priority)}
        </span>
        {item.due_date && (
          <span className={CHIP}>
            <DueFace item={item} today={today} />
          </span>
        )}
      </ChipRow>
    );
  }
  return (
    <ChipRow>
      <TypeChip value={item.work_item_type} types={types} onChange={(work_item_type) => onChange({ work_item_type })} onOpen={onPickerOpen} />
      <PriorityChip priority={item.priority} onChange={(priority) => onChange({ priority })} onOpen={onPickerOpen} />
      <DueChip item={item} today={today} onChange={(due_date) => onChange({ due_date })} onOpen={onPickerOpen} />
    </ChipRow>
  );
}

function ChipRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1">{children}</div>;
}

function TypeChip({
  value,
  types,
  onChange,
  onOpen,
}: {
  value: string;
  types: ReadonlyMap<string, WorkItemType>;
  onChange: (type: string) => void;
  onOpen?: () => void;
}) {
  // Retired types stay readable on the cards that carry them, but are not offered.
  const offered = [...types.values()].filter((t) => t.is_active || t.key === value);
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" className={cn(CHIP, 'hover:bg-muted')} aria-label={`Type: ${typeLabel(value, types)}. Change type`} {...STOP}>
          <Tag className="text-muted-foreground" aria-hidden="true" />
          {typeLabel(value, types)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" {...STOP}>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {offered.map((t) => (
            <DropdownMenuRadioItem key={t.key} value={t.key}>
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityChip({
  priority,
  onChange,
  onOpen,
}: {
  priority: WorkItemPriority;
  onChange: (priority: WorkItemPriority) => void;
  onOpen?: () => void;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(CHIP, 'hover:bg-muted')}
          aria-label={`Priority: ${priorityLabel(priority)}. Change priority`}
          {...STOP}
        >
          <Flag className={PRIORITY_TONE[priority]} aria-hidden="true" />
          {priorityLabel(priority)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" {...STOP}>
        <DropdownMenuRadioGroup value={priority} onValueChange={(v) => onChange(v as WorkItemPriority)}>
          {WORK_ITEM_PRIORITIES.map((p) => (
            <DropdownMenuRadioItem key={p.value} value={p.value} className="gap-2">
              <Flag className={cn('h-3.5 w-3.5', PRIORITY_TONE[p.value])} aria-hidden="true" />
              {p.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function addDays(iso: string, days: number): string {
  const d = parseDateOnly(iso) ?? new Date();
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function DueChip({
  item,
  today,
  onChange,
  onOpen,
}: {
  item: ChipItem;
  today: string;
  onChange: (dueDate: string | null) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDateOnly(item.due_date) ?? undefined;
  const pick = (iso: string | null) => {
    onChange(iso);
    setOpen(false);
  };
  const quick = [
    { label: 'Today', iso: today },
    { label: 'Tomorrow', iso: addDays(today, 1) },
    { label: 'Next week', iso: addDays(today, 7) },
  ];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(CHIP, 'hover:bg-muted')}
          aria-label={item.due_date ? `Due ${formatDate(item.due_date)}. Change due date` : 'Set due date'}
          {...STOP}
        >
          <DueFace item={item} today={today} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" {...STOP}>
        <div className="flex gap-1 border-b border-border p-2">
          {quick.map((q) => (
            <Button key={q.label} type="button" variant="outline" size="xs" onClick={() => pick(q.iso)}>
              {q.label}
            </Button>
          ))}
        </div>
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(d) => pick(d ? toISODate(d) : null)} autoFocus />
        {item.due_date && (
          <div className="border-t border-border p-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => pick(null)}
            >
              Remove due date
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
