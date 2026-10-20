import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Contact } from '@/api/contacts';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { contactRowName } from '../lib/sections';
import { groupByTier, TIER_COLOR, TIER_INK, tierValue, UNRANKED, type TierRowKey } from '../lib/tiers';

/** The pointer's row; with no pointer (a keyboard drag) the row the card overlaps. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

const CARD_CLASS = 'rounded-md border border-border bg-card px-2.5 py-1.5';

/**
 * The Tiers tab: a tier list. One horizontal row per tier, S at the top, then A to E and
 * "Not ranked", the tier's letter on its colour at the left and the clients running left
 * to right. Dragging a client to another row sets their tier; a click opens the record.
 * Active clients only (the `client` status, never one-time or former clients): a tier
 * already set on someone else stays stored, it is just not ranked here. The caller passes
 * the contacts this tab may show (archived ones never reach it) and the page's matcher.
 */
export function TierBoard({
  contacts,
  matches,
  onSaveTier,
  onOpen,
}: {
  contacts: readonly Contact[];
  /** The page's search and board filter, so the rows narrow with them. */
  matches: (c: Contact) => boolean;
  /** Rejects on failure (and has already said so); the card stays where it was. */
  onSaveTier: (contactId: string, tier: string | null) => Promise<void>;
  onOpen: (contactId: string) => void;
}) {
  const rows = useMemo(() => groupByTier(contacts.filter((c) => c.status === 'client' && matches(c)), contactRowName), [contacts, matches]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Contacts whose new tier is saving: their card dims and holds until the save lands.
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  // A drag needs 6px of travel, so a click on a card is still a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const dragging = draggingId ? (contacts.find((c) => c.id === draggingId) ?? null) : null;

  const onDragEnd = async (e: DragEndEvent) => {
    setDraggingId(null);
    const id = String(e.active.id);
    const to = e.over ? (String(e.over.id) as TierRowKey) : null;
    const contact = contacts.find((c) => c.id === id);
    if (!to || !contact || savingIds.has(id)) return;
    const next = tierValue(to);
    if (next === tierValue(contact.tier)) return;
    setSavingIds((prev) => new Set(prev).add(id));
    try {
      await onSaveTier(id, next);
    } catch {
      // The save reported its own failure.
    } finally {
      setSavingIds((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    }
  };

  return (
    <ScrollArea className="h-full min-h-0" fitWidth>
      <div className="p-4 md:p-5">
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={(e) => setDraggingId(String(e.active.id))}
          onDragCancel={() => setDraggingId(null)}
          onDragEnd={(e) => void onDragEnd(e)}
        >
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {rows.map((row) => (
              <TierRow key={row.key} tier={row.key} count={row.people.length}>
                {row.people.map((c) => (
                  <TierCard key={c.id} contact={c} saving={savingIds.has(c.id)} onOpen={onOpen} />
                ))}
              </TierRow>
            ))}
          </div>
          {/* Above every row, so the card stays under the pointer the whole way. */}
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className={cn(CARD_CLASS, 'cursor-grabbing ring-2 ring-ring/50')}>
                <CardBody contact={dragging} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </ScrollArea>
  );
}

function TierRow({ tier, count, children }: { tier: TierRowKey; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: tier });
  const unranked = tier === UNRANKED;
  const label = unranked ? 'Not ranked' : `${tier} tier`;
  return (
    <section ref={setNodeRef} aria-label={label} className={cn('flex min-h-[64px] items-stretch', isOver && 'bg-muted')}>
      <div className="flex w-16 shrink-0 p-1.5" title={`${count} ${count === 1 ? 'client' : 'clients'}`}>
        <div
          className={cn(
            'flex w-full items-center justify-center rounded-md font-bold leading-none',
            unranked ? 'bg-muted px-1 text-center text-[11px] text-muted-foreground' : 'text-[20px]',
          )}
          style={unranked ? undefined : { backgroundColor: TIER_COLOR[tier], color: TIER_INK }}
        >
          {unranked ? 'Not ranked' : tier}
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-wrap content-start gap-1.5 p-2">
        {children}
        {count === 0 && <li className="self-center px-1 text-[12px] text-muted-foreground">Drag a client here</li>}
      </ul>
    </section>
  );
}

function TierCard({ contact, saving, onOpen }: { contact: Contact; saving: boolean; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: contact.id, disabled: saving });
  return (
    <li>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={`Open ${contactRowName(contact)}`}
        onClick={() => onOpen(contact.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(contact.id);
          else listeners?.onKeyDown?.(e);
        }}
        className={cn(
          CARD_CLASS,
          'block max-w-[220px] cursor-grab touch-none select-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
          (isDragging || saving) && 'opacity-40',
        )}
      >
        <CardBody contact={contact} />
      </div>
    </li>
  );
}

function CardBody({ contact }: { contact: Contact }) {
  return (
    <>
      <div className="truncate text-[13px] font-medium leading-4">{contactRowName(contact)}</div>
      {contact.business_name && <div className="truncate text-[11.5px] leading-4 text-muted-foreground">{contact.business_name}</div>}
    </>
  );
}
