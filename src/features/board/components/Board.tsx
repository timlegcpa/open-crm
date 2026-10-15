import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { getErrorMessage } from '@/lib/errors';
import { todayISODate } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  addWorkItemNote,
  archiveWorkItem,
  BOARD_STAGE_KEYS,
  boardKeys,
  deleteWorkItem,
  moveWorkItem,
  reorderLane,
  updateWorkItem,
  type BoardStageKey,
  type WorkItem,
  type WorkItemPatch,
} from '../api';
import {
  applyLaneOrders,
  bucketBoardCards,
  cardDescription,
  draftAfterNoteSaved,
  EVENT_NOTE_MAX,
  groupHistoryById,
  isBoardStage,
  isMoveRejected,
  isNoteRequired,
  LANE_TOO_LONG,
  laneOrderAfterDrop,
  laneOrderFits,
  laneSortedBy,
  stageFromOverId,
  type BoardHistoryEvent,
  type LaneSort,
  type NoteDraft,
} from '../board';
import { useBoardHistory, useBoardStages, useWorkItemTypes } from '../hooks';
import { BoardCard, BoardCardFace, CARD_SURFACE, cardBorderColor } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardHistoryPanel } from './BoardHistoryList';
import { HiddenLanes } from './HiddenLanes';
import { MoveReasonDialog } from './MoveReasonDialog';

interface PendingMove {
  item: WorkItem;
  from: BoardStageKey;
  to: BoardStageKey;
  /** The card or lane it was dropped on; absent for a move from the card menu (it lands on top). */
  dropOn?: string;
}

const NOOP = () => undefined;

/**
 * The board: lanes of cards, drag to move (with a reason) or to reorder within a lane.
 *
 * `items` are the cards the toolbar leaves visible; `laneItems` are every card on the board,
 * BEFORE the toolbar. A reorder or a lane sort is computed over the whole lane, so a search
 * that hides half of a lane cannot renumber the visible half on top of the hidden one.
 */
export function Board({
  items,
  laneItems,
  hiddenLanes,
  onHideLane,
  onShowLane,
  onAddToLane,
  openItemId,
}: {
  items: readonly WorkItem[];
  laneItems: readonly WorkItem[];
  hiddenLanes: readonly BoardStageKey[];
  onHideLane: (stage: BoardStageKey) => void;
  onShowLane: (stage: BoardStageKey) => void;
  onAddToLane: (stage: BoardStageKey) => void;
  /** A card whose history opens once it is on the board (a deep link to one card). */
  openItemId?: string | null;
}) {
  const queryClient = useQueryClient();
  const { rows: stages, columns: boardCols } = useBoardStages();
  const { rows: types } = useWorkItemTypes();
  const historyQuery = useBoardHistory();
  const today = todayISODate();

  // A lane's new order is drawn the moment it is dropped, not after the refetch, or the
  // card snaps back for a round trip. Cleared per lane once its refetch has landed.
  const [laneOrders, setLaneOrders] = useState<Partial<Record<BoardStageKey, string[]>>>({});
  const columns = useMemo(() => applyLaneOrders(bucketBoardCards(items), laneOrders), [items, laneOrders]);
  const fullColumns = useMemo(() => applyLaneOrders(bucketBoardCards(laneItems), laneOrders), [laneItems, laneOrders]);
  const { cardsById, cardStageById } = useMemo(() => {
    const byId = new Map<string, WorkItem>();
    const stageById = new Map<string, BoardStageKey>();
    for (const stage of BOARD_STAGE_KEYS) {
      for (const card of columns[stage]) {
        byId.set(card.id, card);
        stageById.set(card.id, stage);
      }
    }
    return { cardsById: byId, cardStageById: stageById };
  }, [columns]);
  const historyById = useMemo(() => groupHistoryById(historyQuery.data ?? []), [historyQuery.data]);
  const eventsOf = (id: string): BoardHistoryEvent[] => historyById.get(id) ?? [];

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<WorkItem | null>(null);
  const historyFor = historyForId ? cardsById.get(historyForId) ?? null : null;

  // A deep link to one card opens its history once, the first time it is on the board.
  const openedLink = useRef<string | null>(null);
  useEffect(() => {
    if (!openItemId || openedLink.current === openItemId || !cardsById.has(openItemId)) return;
    openedLink.current = openItemId;
    setHistoryForId(openItemId);
  }, [openItemId, cardsById]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space, not the Enter/Space default: Enter opens a card's history, and a sensor
    // sharing that key is how the card's own handler came to be overridden.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const settleBoard = () => queryClient.invalidateQueries({ queryKey: boardKeys.all });
  const settleOpen = () => queryClient.invalidateQueries({ queryKey: boardKeys.open() });

  const moveMutation = useMutation({
    mutationFn: async (args: { item: WorkItem; stage: BoardStageKey; note: string; expectedStage: BoardStageKey; order?: string[]; dropPointGone?: boolean }) => {
      await moveWorkItem({ id: args.item.id, stage: args.stage, note: args.note, expectedStage: args.expectedStage });
      // The old place stops applying the moment the stage changes, so the drop point is
      // written after the move. A failure here leaves the card at the top of its new lane,
      // which is a place, not a loss: say so and keep the move.
      if (!args.order) return { orderError: null };
      try {
        await reorderLane(args.stage, args.order);
        return { orderError: null };
      } catch (err) {
        return { orderError: err };
      }
    },
    onSuccess: (result, vars) => {
      setPending(null);
      if (result.orderError !== null) {
        toast.error('Moved, but its place in the lane was not saved.', {
          description: getErrorMessage(result.orderError, 'It sits at the top of the lane. Drag it to place it.'),
        });
      } else if (vars.dropPointGone) toast('Moved to the top of the lane: the card you dropped it next to has moved.');
    },
    onError: (err) => {
      if (isMoveRejected(err)) {
        setPending(null);
        toast('This card already moved, refreshing.');
        return;
      }
      toast.error(isNoteRequired(err) ? 'A reason is required.' : 'Could not move this card.', {
        description: getErrorMessage(err, 'Please try again.'),
      });
    },
    onSettled: () => settleBoard(),
  });

  // A reorder refetches only the cards. The lane's drawn order is dropped once that lands,
  // and only if it is still the order THIS reorder drew: a second drag in the same lane
  // replaces it, and the first one settling must not wipe the second one's picture.
  const settleLaneOrder = (stage: BoardStageKey, drawn: string[]) => {
    void settleOpen().finally(() =>
      setLaneOrders((prev) => {
        if (prev[stage] !== drawn) return prev;
        const next = { ...prev };
        delete next[stage];
        return next;
      }),
    );
  };

  const reorderMutation = useMutation({
    // One queue for every reorder: two quick drags reach the database in the order they
    // were made, so the last one is the one that sticks.
    scope: { id: 'board-reorder' },
    mutationFn: (args: { stage: BoardStageKey; drawn: string[] }) => reorderLane(args.stage, args.drawn),
    onError: (err) => toast.error('Could not save the new order.', { description: getErrorMessage(err, 'Please try again.') }),
    onSettled: (_data, _err, vars) => settleLaneOrder(vars.stage, vars.drawn),
  });

  // A lane order too long for the server to take is refused here, before anything is drawn
  // or written, so the board never shows an order it could not save.
  const saveLaneOrder = (stage: BoardStageKey, drawn: string[]) => {
    if (!laneOrderFits(drawn)) {
      toast.error(LANE_TOO_LONG);
      return;
    }
    setLaneOrders((prev) => ({ ...prev, [stage]: drawn }));
    reorderMutation.mutateAsync({ stage, drawn }).catch(NOOP);
  };

  // A lane menu sort saves the lane's whole order exactly as a drag does, through the same
  // queue: computed over the full lane, drawn at once.
  const sortLane = (stage: BoardStageKey, by: LaneSort) => {
    const order = laneSortedBy(fullColumns[stage], by);
    if (order.length < 2) return;
    saveLaneOrder(stage, order);
  };

  // Type, priority and due date from the card chips: drawn at once, rolled back on failure.
  const changeMutation = useMutation({
    mutationFn: (args: { id: string; patch: WorkItemPatch }) => updateWorkItem(args.id, args.patch),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: boardKeys.open() });
      const previous = queryClient.getQueryData<WorkItem[]>(boardKeys.open());
      queryClient.setQueryData<WorkItem[]>(boardKeys.open(), (rows) => rows?.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(boardKeys.open(), context.previous);
      toast.error('Could not save the change.', { description: getErrorMessage(err, 'Please try again.') });
    },
    onSettled: () => settleOpen(),
  });

  const archiveMutation = useMutation({
    mutationFn: (item: WorkItem) => archiveWorkItem(item.id),
    onSuccess: () => {
      setHistoryForId(null);
      toast('Archived. Open Archived to bring it back.');
    },
    onError: (err) => toast.error('Could not archive this card.', { description: getErrorMessage(err, 'Please try again.') }),
    onSettled: () => settleBoard(),
  });

  const deleteMutation = useMutation({
    mutationFn: (item: WorkItem) => deleteWorkItem(item.id),
    onSuccess: () => {
      setDeleteFor(null);
      setHistoryForId(null);
      toast('Work item deleted.');
    },
    onError: (err) => toast.error('Could not delete this card.', { description: getErrorMessage(err, 'Please try again.') }),
    onSettled: () => settleBoard(),
  });

  // The note composer in the history dialog: a note lands in the timeline without a move.
  // It writes only history, so only the history read refetches.
  const [noteDraft, setNoteDraft] = useState<NoteDraft>({ itemId: null, text: '' });
  useEffect(() => {
    setNoteDraft({ itemId: historyForId, text: '' });
  }, [historyForId]);
  const noteMutation = useMutation({
    mutationFn: (args: { id: string; note: string }) => addWorkItemNote(args.id, args.note),
    onSuccess: (_data, saved) => setNoteDraft((draft) => draftAfterNoteSaved(draft, saved)),
    onError: (err) => toast.error('Could not add the note.', { description: getErrorMessage(err, 'Please try again.') }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKeys.events() }),
  });

  const requestMove = (item: WorkItem, to: BoardStageKey, dropOn?: string) => {
    if (item.stage === to) return;
    setPending({ item, from: item.stage, to, dropOn });
  };

  // Cards first, the lane only where no card is. `closestCenter` alone ranks the lane (a
  // droppable as tall as the column) against its own cards by centre distance, so a drop
  // in the middle of a full lane picked the lane and sent the card to the bottom. With a
  // pointer: the card under it; in a gap or a lane's empty space, the first card of that
  // lane below the pointer, or the lane itself (the bottom) when no card is below. The
  // keyboard has no pointer: it steps card to card, and an EMPTY lane stays a target since
  // it has no card to step onto. So does a HIDDEN lane: its cards are not mounted.
  const collision: CollisionDetection = (args) => {
    if (!args.pointerCoordinates) {
      const occupied = new Set([...cardStageById.values()].filter((s) => !hiddenLanes.includes(s)));
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => {
          const id = String(c.id);
          return !isBoardStage(id) || !occupied.has(id);
        }),
      });
    }
    const within = pointerWithin(args);
    const onCard = within.find((c) => !isBoardStage(String(c.id)));
    if (onCard) return [onCard];
    const lane = within.find((c) => isBoardStage(String(c.id)));
    if (!lane) return [];
    const y = args.pointerCoordinates.y;
    let below: { id: string; top: number } | null = null;
    for (const c of args.droppableContainers) {
      const id = String(c.id);
      if (isBoardStage(id) || cardStageById.get(id) !== lane.id) continue;
      const rect = args.droppableRects.get(c.id);
      if (!rect || rect.top < y) continue;
      if (!below || rect.top < below.top) below = { id, top: rect.top };
    }
    return below ? [{ id: below.id }] : [lane];
  };

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const handleDragOver = (event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null);
  const handleDragCancel = () => {
    setActiveId(null);
    setOverId(null);
  };

  // Same lane: a reorder, saved at once. Another lane: the reason dialog, with the drop
  // point carried through it so the card lands where it was let go.
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    handleDragCancel();
    if (!over) return;
    const item = cardsById.get(String(active.id));
    const to = stageFromOverId(over.id, cardStageById);
    if (!item || !to) return;
    if (item.stage !== to) {
      // Refused before the reason is asked for: the move and its place are one gesture.
      const into = laneOrderAfterDrop(fullColumns[to], item.id, String(over.id));
      if (into && !laneOrderFits(into)) {
        toast.error(LANE_TOO_LONG);
        return;
      }
      requestMove(item, to, String(over.id));
      return;
    }
    const order = laneOrderAfterDrop(fullColumns[to], item.id, String(over.id));
    if (order) saveLaneOrder(to, order);
  };

  const visibleColumns = boardCols.filter((col) => !hiddenLanes.includes(col.stage));
  const hiddenColumns = boardCols.filter((col) => hiddenLanes.includes(col.stage));
  const activeCard = activeId ? cardsById.get(activeId) ?? null : null;
  // The lane a dragged card would MOVE into, never its own: a reorder shows itself by the
  // cards making room, a move by the lane lighting up.
  const overStage = overId ? stageFromOverId(overId, cardStageById) : null;
  const incomingStage = activeCard && overStage && overStage !== activeCard.stage ? overStage : null;
  const canAddNote = noteDraft.text.trim() !== '' && !noteMutation.isPending;
  const counts = { todo: columns.todo.length, waiting: columns.waiting.length, doing: columns.doing.length, done: columns.done.length };
  const pendingLabel = pending ? boardCols.find((c) => c.stage === pending.to)?.title ?? pending.to : '';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* The lanes take the height the page gives them and scroll inside themselves. Too
          narrow for every lane side by side, the row scrolls sideways instead of stacking,
          and a phone snaps one lane per swipe; the snap is off while a card is in the hand,
          or it fights the drag's edge auto-scroll. */}
      <ScrollArea
        horizontal
        className={cn(
          'min-h-0 w-full min-w-0 flex-1',
          // The viewport's content box fills its height (so each lane can scroll), as a
          // block rather than Radix's table, which would leave the lanes unbounded.
          '[&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]>div]:h-full',
          activeId === null &&
            '[&>[data-radix-scroll-area-viewport]]:snap-x [&>[data-radix-scroll-area-viewport]]:snap-mandatory md:[&>[data-radix-scroll-area-viewport]]:snap-none',
        )}
      >
        <div
          className="flex h-full gap-3.5 pb-2.5"
          style={{ minWidth: `${visibleColumns.length * 14 + (hiddenColumns.length > 0 ? 12 : 0)}rem` }}
        >
          {visibleColumns.map((col) => (
            <BoardColumn
              key={col.stage}
              column={col}
              count={columns[col.stage].length}
              sortableCount={fullColumns[col.stage].length}
              incoming={incomingStage === col.stage}
              onAdd={() => onAddToLane(col.stage)}
              onSort={(by) => sortLane(col.stage, by)}
              onHide={() => onHideLane(col.stage)}
            >
              <SortableContext items={columns[col.stage].map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {columns[col.stage].map((item) => (
                  <Fragment key={item.id}>
                    {/* A lane the card is arriving in shows the slot with this line: the
                        card goes in just above the one it is over. */}
                    {incomingStage === col.stage && overId === item.id && <div aria-hidden="true" className="h-0.5 shrink-0 rounded-full bg-link/60" />}
                    <BoardCard
                      item={item}
                      events={eventsOf(item.id)}
                      stages={stages}
                      columns={boardCols}
                      types={types}
                      today={today}
                      onOpenHistory={() => setHistoryForId(item.id)}
                      onMove={(to) => requestMove(item, to)}
                      onChange={(patch) => changeMutation.mutateAsync({ id: item.id, patch }).catch(NOOP)}
                      onArchive={() => archiveMutation.mutateAsync(item).catch(NOOP)}
                      onDelete={() => setDeleteFor(item)}
                    />
                  </Fragment>
                ))}
              </SortableContext>
            </BoardColumn>
          ))}
          {hiddenColumns.length > 0 && <HiddenLanes columns={hiddenColumns} counts={counts} onShow={onShowLane} />}
        </div>
      </ScrollArea>

      <DragOverlay>
        {activeCard ? (
          // The one card in the hand: it keeps its lane's outline, and the shadow lifts it.
          <div className={cn('w-[13rem] rotate-2 cursor-grabbing shadow-md', CARD_SURFACE)} style={{ borderColor: cardBorderColor(activeCard, stages) }}>
            <BoardCardFace item={activeCard} events={eventsOf(activeCard.id)} types={types} today={today} />
          </div>
        ) : null}
      </DragOverlay>

      <MoveReasonDialog
        move={pending ? { key: pending.item.id, to: pending.to, toLabel: pendingLabel, description: cardDescription(pending.item) } : null}
        submitting={moveMutation.isPending}
        onCancel={() => {
          if (!moveMutation.isPending) setPending(null);
        }}
        onConfirm={(note) => {
          if (!pending) return;
          // Read at confirm, not at drop: the lane may have changed while the reason was
          // being typed. A cross-lane drop is never a no-op, so null means the card it was
          // dropped next to has left the lane.
          const order = pending.dropOn ? laneOrderAfterDrop(fullColumns[pending.to], pending.item.id, pending.dropOn) ?? undefined : undefined;
          // The lane may have grown past the limit while the reason was typed: refuse the
          // whole move rather than commit the stage and lose the place.
          if (order && !laneOrderFits(order)) {
            toast.error(LANE_TOO_LONG);
            return;
          }
          moveMutation
            .mutateAsync({
              item: pending.item,
              stage: pending.to,
              note,
              expectedStage: pending.from,
              order,
              dropPointGone: pending.dropOn !== undefined && order === undefined,
            })
            .catch(NOOP);
        }}
      />

      <Dialog
        open={historyFor !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryForId(null);
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col">
          <DialogHeader>
            <DialogTitle className="pr-6 [overflow-wrap:anywhere]">{historyFor ? cardDescription(historyFor) : 'History'}</DialogTitle>
            <DialogDescription>Notes and moves, newest first.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="board-note">Add a note</Label>
            <Textarea
              id="board-note"
              maxLength={EVENT_NOTE_MAX}
              value={noteDraft.text}
              onChange={(e) => setNoteDraft({ itemId: historyForId, text: e.target.value })}
              rows={3}
              placeholder="What changed?"
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={!canAddNote}
                onClick={() => {
                  if (historyFor) noteMutation.mutateAsync({ id: historyFor.id, note: noteDraft.text.trim() }).catch(NOOP);
                }}
              >
                {noteMutation.isPending ? 'Saving...' : 'Add note'}
              </Button>
            </div>
          </div>
          <ScrollArea fitWidth className="min-h-0 [&>[data-radix-scroll-area-viewport]]:max-h-[45vh]">
            <BoardHistoryPanel
              status={historyQuery.status}
              events={historyFor ? eventsOf(historyFor.id) : []}
              rows={stages}
              onRetry={() => void historyQuery.refetch()}
            />
          </ScrollArea>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (historyFor) archiveMutation.mutateAsync(historyFor).catch(NOOP);
              }}
            >
              {archiveMutation.isPending ? 'Archiving...' : 'Archive'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteFor !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this work item?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFor ? `${cardDescription(deleteFor)}. ` : ''}It goes for good, and its notes go with it. Archive keeps it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteFor) deleteMutation.mutateAsync(deleteFor).catch(NOOP);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DndContext>
  );
}
