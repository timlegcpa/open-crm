/**
 * The board's pure rules: lanes, buckets and order, history shaping, drop math, priority
 * and due dates, lane sorts, hidden lanes, the Overview figures and the Activity feed. No
 * React, no Supabase.
 *
 * Code reads a stage by its KEY, never by its label: labels are the owner's to edit, and
 * history shows the current label of the stored key. The one key the code branches on is
 * `done` (it archives, it is never overdue, it gets the Done pill).
 */
import { contactDisplayName } from '@/api/contacts';
import { formatDateShort } from '@/lib/format';
import {
  BOARD_STAGE_KEYS,
  WORK_ITEM_PRIORITY_KEYS,
  type BoardStage,
  type BoardStageKey,
  type HistoryEventRow,
  type WorkItem,
  type WorkItemPriority,
} from './api';

// ── Lanes ──────────────────────────────────────────────────────────────────

/** The line under each lane's title. Done's must agree with the archive interval in 0008. */
export const STAGE_HINTS: Record<BoardStageKey, string> = {
  todo: 'Not started',
  waiting: 'Waiting on someone else',
  doing: 'Being worked on',
  done: 'Archives after 14 days',
};

export function isBoardStage(value: string | null | undefined): value is BoardStageKey {
  return typeof value === 'string' && (BOARD_STAGE_KEYS as readonly string[]).includes(value);
}

/** A stored key spelled for a person: its current label, else the key de-snaked (never a raw key). */
export function stageLabel(key: string | null, rows: ReadonlyMap<string, BoardStage>): string {
  if (key === null || key === '') return '';
  const row = rows.get(key);
  if (row) return row.label;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface BoardColumn {
  stage: BoardStageKey;
  title: string;
  hint: string;
  /** The owner's colour for the lane, or null for its default tone. */
  colour: string | null;
}

/** The lanes in the owner's order (key breaks a tie); a lane whose row has not loaded keeps its key's place. */
export function boardColumns(rows: ReadonlyMap<string, BoardStage>): BoardColumn[] {
  return BOARD_STAGE_KEYS.map((stage, index) => {
    const row = rows.get(stage);
    return { stage, title: stageLabel(stage, rows), hint: STAGE_HINTS[stage], colour: row?.colour ?? null, order: row?.sort_order ?? index };
  })
    .sort((a, b) => a.order - b.order || a.stage.localeCompare(b.stage))
    .map(({ order: _order, ...column }) => column);
}

// ── Moves ──────────────────────────────────────────────────────────────────

/** Quick reasons for a move. Three to five, so the row stays one line. */
export const MOVE_REASON_CHIPS: readonly string[] = [
  'Started work',
  'Waiting on the client',
  'Client responded',
  'Sent for signature',
  'Ready for review',
];

export const DONE_REASON_CHIP = 'Done';

/** The quick-reason pills for a move into `to`: a move to Done gets a Done pill, first in the row. */
export function moveReasonChips(to: BoardStageKey): readonly string[] {
  return to === 'done' ? [DONE_REASON_CHIP, ...MOVE_REASON_CHIPS] : MOVE_REASON_CHIPS;
}

/**
 * The reason the move dialog opens with: Done for the Done lane, so marking a card done is
 * one click on Confirm (the database still requires a reason). Other lanes start empty, so
 * their reason is still a choice.
 */
export function defaultMoveNote(to: BoardStageKey): string {
  return to === 'done' ? DONE_REASON_CHIP : '';
}

/** The CHECK on `work_items.title`. */
export const WORK_ITEM_TITLE_MAX = 200;
/** The CHECK on a history note. */
export const EVENT_NOTE_MAX = 2000;

export const NO_NOTE_RECORDED = 'no note recorded';

export const WORK_ITEM_PRIORITIES: readonly { value: WorkItemPriority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

export function isMoveRejected(err: unknown): boolean {
  return messageIncludes(err, 'move_rejected');
}

export function isNoteRequired(err: unknown): boolean {
  return messageIncludes(err, 'note_required');
}

function messageIncludes(err: unknown, sentinel: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes(sentinel);
}

// ── Cards ──────────────────────────────────────────────────────────────────

/** The card's contact as a name, or '' when it has none. */
export function cardContactName(item: Pick<WorkItem, 'contact'>): string {
  return item.contact ? contactDisplayName(item.contact) : '';
}

/** "Call back for Ada Lovelace", or just the title when there is no contact. */
export function cardDescription(item: Pick<WorkItem, 'title' | 'contact'>): string {
  const contact = cardContactName(item);
  return contact ? `${item.title} for ${contact}` : item.title;
}

export type BoardColumns = Record<BoardStageKey, WorkItem[]>;

export function emptyColumns(): BoardColumns {
  return { todo: [], waiting: [], doing: [], done: [] };
}

/**
 * The saved order outranks everything else. A card never placed in its lane sorts ABOVE
 * the placed ones, so a new card is seen before it is placed; among themselves those are
 * newest first (the one just added is the one being looked for), the id breaking a tie so
 * the order never shuffles. A lane nobody has ordered is all unplaced and reads newest first.
 */
export function compareBoardCards(a: WorkItem, b: WorkItem): number {
  const pa = a.lane_position;
  const pb = b.lane_position;
  if (pa === null && pb !== null) return -1;
  if (pa !== null && pb === null) return 1;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  return b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
}

/** Unarchived cards into their lanes, each lane in board order. */
export function bucketBoardCards(items: readonly WorkItem[]): BoardColumns {
  const columns = emptyColumns();
  for (const item of items) {
    if (item.archived_at !== null) continue;
    if (!isBoardStage(item.stage)) continue;
    columns[item.stage].push(item);
  }
  for (const stage of BOARD_STAGE_KEYS) columns[stage].sort(compareBoardCards);
  return columns;
}

/** Every card on the board: the figure the page subtitle carries. */
export function boardCardCount(columns: BoardColumns): number {
  return Object.values(columns).reduce((n, cards) => n + cards.length, 0);
}

export function boardIsEmpty(columns: BoardColumns): boolean {
  return boardCardCount(columns) === 0;
}

/** How many distinct contacts the board's cards belong to. A card with no contact counts no one. */
export function boardMix(columns: BoardColumns): { contacts: number; cards: number } {
  const contacts = new Set<string>();
  for (const cards of Object.values(columns)) {
    for (const card of cards) if (card.contact_id) contacts.add(card.contact_id);
  }
  return { contacts: contacts.size, cards: boardCardCount(columns) };
}

/** Case-insensitive substring of the title or the contact's name; an empty query matches all. */
export function cardMatchesQuery(item: Pick<WorkItem, 'title' | 'contact'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [item.title, cardContactName(item)].some((text) => text.toLowerCase().includes(needle));
}

/**
 * The toolbar filters. `contactFilter` narrows to one contact's cards (a card with no
 * contact is nobody's).
 */
export function filterWorkItems(items: readonly WorkItem[], query: string, contactFilter: string | null): WorkItem[] {
  return items.filter((item) => {
    if (contactFilter !== null && item.contact_id !== contactFilter) return false;
    return cardMatchesQuery(item, query);
  });
}

// ── History ────────────────────────────────────────────────────────────────

export interface BoardHistoryEvent {
  id: string;
  /** The card's creation (toValue is the lane it started in), a stage move, or a note logged without one. */
  kind: 'created' | 'move' | 'note';
  fromValue: string | null;
  toValue: string | null;
  at: string;
  note: string | null;
}

export function noteFromDetail(detail: unknown): string | null {
  if (detail == null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const note = (detail as { note?: unknown }).note;
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

const EVENT_KIND = { created: 'created', stage_changed: 'move', note_added: 'note' } as const;

/**
 * Newest first, the id breaking a tie. A `note_added` row has no ends and renders as the
 * note alone; a `created` row has only the lane the card started in.
 */
export function shapeHistory(events: readonly HistoryEventRow[]): BoardHistoryEvent[] {
  return [...events]
    .sort((a, b) => {
      const byTime = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
    })
    .map((event) => ({
      id: event.id,
      kind: EVENT_KIND[event.event_type],
      fromValue: event.from_value,
      toValue: event.to_value,
      at: event.created_at,
      note: noteFromDetail(event.detail),
    }));
}

/** History keyed by card id, each newest first. */
export function groupHistoryById(events: readonly HistoryEventRow[]): Map<string, BoardHistoryEvent[]> {
  const grouped = new Map<string, HistoryEventRow[]>();
  for (const event of events) {
    const list = grouped.get(event.work_item_id);
    if (list) list.push(event);
    else grouped.set(event.work_item_id, [event]);
  }
  return new Map([...grouped].map(([id, list]) => [id, shapeHistory(list)]));
}

/**
 * The last note anybody logged on the card, which is what its face shows. Not an age: an
 * age answers a question nobody asks at a board, and the sentence written when the card
 * last moved says what is going on. Do not put an age chip on a card. A note-less move is
 * skipped rather than shown as NO_NOTE_RECORDED, which exists only for the history list.
 */
export function latestNote(events: readonly BoardHistoryEvent[]): string | null {
  for (const event of events) if (event.note) return event.note;
  return null;
}

// ── The note composer ──────────────────────────────────────────────────────

/** The history dialog's note draft, and the card it was typed for. */
export interface NoteDraft {
  itemId: string | null;
  text: string;
}

/**
 * The draft once a note has saved. Cleared only while it is still the one that was sent:
 * a save is slow enough that the owner may have opened another card, or kept typing, and
 * a late success must not wipe what was typed since.
 */
export function draftAfterNoteSaved(draft: NoteDraft, saved: { id: string; note: string }): NoteDraft {
  return draft.itemId === saved.id && draft.text.trim() === saved.note ? { itemId: saved.id, text: '' } : draft;
}

// ── Drag and drop ──────────────────────────────────────────────────────────

/**
 * The most cards one lane order may name: reorder_board_lane refuses a longer list
 * (invalid_cards). The board sends whole lanes, so it checks this before writing anything.
 */
export const MAX_LANE_CARDS = 2000;

export const LANE_TOO_LONG = `This lane has more than ${MAX_LANE_CARDS.toLocaleString('en-US')} cards, so its order cannot be saved. Archive some cards first.`;

/** Whether a lane order is short enough to save. */
export function laneOrderFits(order: readonly string[]): boolean {
  return order.length <= MAX_LANE_CARDS;
}

/** The lane a drop lands in: the lane itself, or the lane of the card dropped on. */
export function stageFromOverId(overId: string | number, cardStageById: ReadonlyMap<string, BoardStageKey>): BoardStageKey | null {
  const id = String(overId);
  if (isBoardStage(id)) return id;
  return cardStageById.get(id) ?? null;
}

/**
 * The board as drawn while a reorder is in flight: each lane in `orders` takes that id
 * order. A card in the lane but not in the order (one that arrived since) goes on top, the
 * same place an unplaced card sorts; an id no longer in the lane is skipped.
 */
export function applyLaneOrders(columns: BoardColumns, orders: Partial<Record<BoardStageKey, readonly string[]>>): BoardColumns {
  const next = { ...columns };
  for (const stage of BOARD_STAGE_KEYS) {
    const order = orders[stage];
    if (!order) continue;
    const byId = new Map(columns[stage].map((c) => [c.id, c] as const));
    const placed = new Set(order);
    next[stage] = [...columns[stage].filter((c) => !placed.has(c.id)), ...order.flatMap((id) => byId.get(id) ?? [])];
  }
  return next;
}

/**
 * The target lane's whole order, top first, once `activeId` is dropped on `overId`. `lane`
 * is that lane as drawn. Within its own lane the card takes the place of the card it was
 * dropped on; arriving from another lane it goes in just above that card; dropped on the
 * lane itself rather than a card, it goes to the bottom.
 *
 * Null when nothing would change (a drop back onto its own spot writes nothing), and when
 * `overId` is a card no longer in the lane (it moved or was archived while the reason
 * dialog was open): the drop point is gone, and guessing the bottom would save a place
 * nobody chose.
 */
export function laneOrderAfterDrop(lane: readonly Pick<WorkItem, 'id'>[], activeId: string, overId: string): string[] | null {
  if (overId === activeId) return null;
  const ids = lane.map((c) => c.id);
  const from = ids.indexOf(activeId);
  const rest = ids.filter((id) => id !== activeId);
  const overIndex = ids.indexOf(overId);
  if (overIndex === -1 && !isBoardStage(overId)) return null;
  let to: number;
  if (overIndex === -1) to = rest.length;
  else if (from === -1) to = overIndex;
  else to = rest.indexOf(overId) + (overIndex > from ? 1 : 0);
  if (from !== -1 && to === from) return null;
  return [...rest.slice(0, to), activeId, ...rest.slice(to)];
}

// ── Priority, due dates, lane sorts ────────────────────────────────────────

const PRIORITY_RANK: Record<WorkItemPriority, number> = { urgent: 0, normal: 1, low: 2 };

export function priorityLabel(priority: WorkItemPriority): string {
  return WORK_ITEM_PRIORITIES.find((p) => p.value === priority)?.label ?? 'Normal';
}

/** Whole calendar days from `fromISO` to `toISO`, both 'YYYY-MM-DD' (daylight saving and month ends included). */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toISO) - utc(fromISO)) / 86_400_000);
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'done';

/** "Due soon": within this many days. */
export const DUE_SOON_DAYS = 7;

/**
 * What a card's due chip says, against the viewer's local today. Null when it has no date.
 * A Done card keeps its date but is never overdue: the work happened.
 */
export function workItemDue(item: Pick<WorkItem, 'due_date' | 'stage'>, todayISO: string): { state: DueState; label: string } | null {
  if (!item.due_date) return null;
  const days = daysBetweenISO(todayISO, item.due_date);
  const date = formatDateShort(item.due_date);
  if (item.stage === 'done') return { state: 'done', label: `Due ${date}` };
  if (days < 0) return { state: 'overdue', label: `Overdue · ${date}` };
  if (days === 0) return { state: 'today', label: 'Due today' };
  if (days === 1) return { state: 'soon', label: 'Due tomorrow' };
  if (days <= DUE_SOON_DAYS) return { state: 'soon', label: `Due ${date}` };
  return { state: 'later', label: `Due ${date}` };
}

export type LaneSort = 'priority' | 'due';

/**
 * A lane re-ordered by priority or by due date, as ids for reorder_board_lane. Stable:
 * ties keep the lane's current order, so a second sort by the other key refines rather
 * than scrambles. An undated card goes to the bottom of a due sort. `lane` is the WHOLE
 * lane, before the toolbar filter, for the same reason a drag reorder uses it.
 */
export function laneSortedBy(lane: readonly WorkItem[], by: LaneSort): string[] {
  const keyed = lane.map((card, index) => ({ card, index }));
  keyed.sort((a, b) => {
    let diff: number;
    if (by === 'priority') {
      diff = PRIORITY_RANK[a.card.priority] - PRIORITY_RANK[b.card.priority];
    } else {
      const da = a.card.due_date;
      const db = b.card.due_date;
      // One symmetric expression for "undated sorts last", so the comparator agrees with
      // itself whichever side the engine passes first.
      if (da === null || db === null) diff = (da === null ? 1 : 0) - (db === null ? 1 : 0);
      else diff = da.localeCompare(db);
    }
    return diff !== 0 ? diff : a.index - b.index;
  });
  return keyed.map(({ card }) => card.id);
}

// ── Hidden lanes ───────────────────────────────────────────────────────────

/**
 * Lanes the viewer has hidden, as stored in this browser: current keys only, in lane-key
 * order. Anything else (junk, a key that no longer exists) is dropped on read, so the
 * board always draws.
 */
export function parseHiddenLanes(stored: unknown): BoardStageKey[] {
  if (!Array.isArray(stored)) return [];
  return BOARD_STAGE_KEYS.filter((stage) => stored.includes(stage));
}

// ── Overview ───────────────────────────────────────────────────────────────

export interface BoardOverview {
  total: number;
  open: number;
  overdue: number;
  dueSoon: number;
  done: number;
  byStage: { stage: BoardStageKey; title: string; colour: string | null; count: number }[];
  /** Open (not Done) cards per contact, most first; cards with no contact are left out. */
  byContact: { id: string; name: string; count: number }[];
  /** Open cards per priority, in priority order. */
  byPriority: { value: WorkItemPriority; label: string; count: number }[];
}

/** The Overview tab's figures, from the columns the board draws, so the toolbar filter applies to both. */
export function boardOverview(columns: BoardColumns, board: readonly BoardColumn[], todayISO: string): BoardOverview {
  let overdue = 0;
  let dueSoon = 0;
  const contacts = new Map<string, { name: string; count: number }>();
  const priorities: Record<WorkItemPriority, number> = { urgent: 0, normal: 0, low: 0 };
  for (const stage of BOARD_STAGE_KEYS) {
    if (stage === 'done') continue;
    for (const card of columns[stage]) {
      priorities[card.priority] += 1;
      const due = workItemDue(card, todayISO);
      if (due?.state === 'overdue') overdue += 1;
      else if (due?.state === 'today' || due?.state === 'soon') dueSoon += 1;
      if (!card.contact_id) continue;
      const entry = contacts.get(card.contact_id);
      if (entry) entry.count += 1;
      else contacts.set(card.contact_id, { name: cardContactName(card), count: 1 });
    }
  }
  const total = boardCardCount(columns);
  const done = columns.done.length;
  return {
    total,
    open: total - done,
    overdue,
    dueSoon,
    done,
    byStage: board.map((col) => ({ stage: col.stage, title: col.title, colour: col.colour, count: columns[col.stage].length })),
    byContact: [...contacts.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    byPriority: WORK_ITEM_PRIORITY_KEYS.map((value) => ({ value, label: priorityLabel(value), count: priorities[value] })),
  };
}

// ── Activity ───────────────────────────────────────────────────────────────

export interface ActivityEntry extends BoardHistoryEvent {
  /** "Call back for Ada Lovelace", or the fallback when the card is not on the board. */
  subject: string;
}

export const ACTIVITY_UNKNOWN_SUBJECT = 'A card no longer on the board';

/** Every card's description by id, for naming feed rows. */
export function cardDescriptionsById(items: readonly WorkItem[]): Map<string, string> {
  return new Map(items.map((item) => [item.id, cardDescription(item)]));
}

/** Every creation, move and note as one newest-first feed, capped at `limit` rows. */
export function boardActivity(events: readonly HistoryEventRow[], descriptions: ReadonlyMap<string, string>, limit = 150): ActivityEntry[] {
  const subjectOf = new Map(events.map((e) => [e.id, e.work_item_id] as const));
  return shapeHistory(events)
    .slice(0, limit)
    .map((event) => ({ ...event, subject: descriptions.get(subjectOf.get(event.id) ?? '') || ACTIVITY_UNKNOWN_SUBJECT }));
}
