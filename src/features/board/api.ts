import { z } from 'zod';
import { definePickList } from '@/api/pickLists';
import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';

/**
 * The board's reads and writes (0008_board.sql). Four of the writes go through RPCs, and
 * the reason is a grant rather than a convention: a signed-in session cannot INSERT a
 * card, cannot UPDATE `work_items.stage` or `lane_position`, and `work_item_events` has no
 * write policy at all. So `createWorkItem`, `moveWorkItem`, `addWorkItemNote` and
 * `reorderLane` are the only paths that create a card, change a stage, write history or
 * place a card. Edit, archive, restore and delete are ordinary owner-only writes.
 *
 * Every read is paged on `id` (never a silent 1,000-row cap) and parsed at the boundary;
 * the board sorts on the client, so the database order carries nothing.
 */

// ── Pick-lists ─────────────────────────────────────────────────────────────

/** The board's lanes, in their fixed order of keys. Labels, colours and display order are the owner's. */
export const BOARD_STAGE_KEYS = ['todo', 'waiting', 'doing', 'done'] as const;
export type BoardStageKey = (typeof BOARD_STAGE_KEYS)[number];

/** A row of `board_stages`. */
export interface BoardStage {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
}

/** A row of `work_item_types`. */
export interface WorkItemType {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

export const BOARD_STAGES = definePickList<BoardStage>('board_stages', 'key, label, colour, sort_order');
export const WORK_ITEM_TYPES = definePickList<WorkItemType>(
  'work_item_types',
  'key, label, colour, sort_order, is_active, is_system',
);

/** The system type every new card defaults to (the column default in 0008). */
export const DEFAULT_WORK_ITEM_TYPE = 'task';

// ── Rows ───────────────────────────────────────────────────────────────────

export const WORK_ITEM_PRIORITY_KEYS = ['urgent', 'normal', 'low'] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITY_KEYS)[number];

const workItemSchema = z.object({
  id: z.string(),
  contact_id: z.string().nullable(),
  title: z.string(),
  work_item_type: z.string(),
  stage: z.enum(BOARD_STAGE_KEYS),
  priority: z.enum(WORK_ITEM_PRIORITY_KEYS),
  due_date: z.string().nullable(),
  lane_position: z.number().int().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  contact: z
    .object({ id: z.string(), full_name: z.string(), business_name: z.string().nullable() })
    .nullable(),
});

/** A `work_items` row with its contact's name, as the board reads it. */
export type WorkItem = z.infer<typeof workItemSchema>;

const historyEventSchema = z.object({
  id: z.string(),
  work_item_id: z.string(),
  event_type: z.enum(['created', 'stage_changed', 'note_added']),
  from_value: z.string().nullable(),
  to_value: z.string().nullable(),
  created_at: z.string(),
  detail: z.unknown().nullable(),
});

/** One `work_item_events` row: a card's creation, a move with its reason, or a note logged without a move. */
export type HistoryEventRow = z.infer<typeof historyEventSchema>;

const WORK_ITEM_COLUMNS =
  'id, contact_id, title, work_item_type, stage, priority, due_date, lane_position, archived_at, created_at, ' +
  'contact:contacts(id, full_name, business_name)';

const EVENT_COLUMNS = 'id, work_item_id, event_type, from_value, to_value, created_at, detail';

// ── Query keys ─────────────────────────────────────────────────────────────

/** Every board key starts with 'board', so one invalidation settles the whole board. */
export const boardKeys = {
  all: ['board'] as const,
  open: () => ['board', 'open'] as const,
  archived: () => ['board', 'archived'] as const,
  events: () => ['board', 'events'] as const,
};

// ── Reads ──────────────────────────────────────────────────────────────────

function listWorkItems(archived: boolean): Promise<WorkItem[]> {
  return fetchAllPaged<WorkItem>(async (afterId) => {
    let query = getSupabase().from('work_items').select(WORK_ITEM_COLUMNS);
    query = archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    return { data: error ? null : z.array(workItemSchema).parse(data ?? []), error };
  });
}

/** Every card on the board (unarchived). */
export const listOpenWorkItems = () => listWorkItems(false);

/** Every archived card. */
export const listArchivedWorkItems = () => listWorkItems(true);

/**
 * Every move and note. The board reads all of them on each load (the last note on each
 * card, the history dialog, the Activity tab); the note cap in 0008 bounds one row.
 */
export function listWorkItemEvents(): Promise<HistoryEventRow[]> {
  return fetchAllPaged<HistoryEventRow>(async (afterId) => {
    let query = getSupabase().from('work_item_events').select(EVENT_COLUMNS);
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    return { data: error ? null : z.array(historyEventSchema).parse(data ?? []), error };
  });
}

// ── Writes ─────────────────────────────────────────────────────────────────

export interface NewWorkItem {
  title: string;
  contact_id: string | null;
  work_item_type: string;
  stage: BoardStageKey;
  priority: WorkItemPriority;
  due_date: string | null;
  /** The starting note; blank records none. */
  note: string;
}

/**
 * Creates a card and records the lane it started in, with its starting note, in one
 * transaction (create_work_item). Returns the new card's id.
 */
export async function createWorkItem(input: NewWorkItem): Promise<string> {
  const { data, error } = await getSupabase().rpc('create_work_item', {
    p_title: input.title,
    p_contact_id: input.contact_id,
    p_work_item_type: input.work_item_type,
    p_stage: input.stage,
    p_priority: input.priority,
    p_due_date: input.due_date,
    p_note: input.note,
  });
  if (error) throw error;
  return z.string().parse(data);
}

/** What a card's chips edit in place. The grant admits these; never the stage. */
export interface WorkItemPatch {
  priority?: WorkItemPriority;
  due_date?: string | null;
  work_item_type?: string;
}

export async function updateWorkItem(id: string, patch: WorkItemPatch): Promise<void> {
  const { error } = await getSupabase().from('work_items').update(patch).eq('id', id);
  if (error) throw error;
}

/** Moves a card and records the reason, in one transaction (move_work_item_stage). */
export async function moveWorkItem(args: { id: string; stage: BoardStageKey; note: string; expectedStage: BoardStageKey }): Promise<void> {
  const { error } = await getSupabase().rpc('move_work_item_stage', {
    p_id: args.id,
    p_stage: args.stage,
    p_note: args.note,
    p_expected_stage: args.expectedStage,
  });
  if (error) throw error;
}

/** Logs a note on a card without moving it. */
export async function addWorkItemNote(id: string, note: string): Promise<void> {
  const { error } = await getSupabase().rpc('add_work_item_note', { p_id: id, p_note: note });
  if (error) throw error;
}

/** Saves a lane's whole order, top first. */
export async function reorderLane(stage: BoardStageKey, ids: readonly string[]): Promise<void> {
  const { error } = await getSupabase().rpc('reorder_board_lane', { p_stage: stage, p_ids: [...ids] });
  if (error) throw error;
}

export async function archiveWorkItem(id: string): Promise<void> {
  const { error } = await getSupabase().from('work_items').update({ archived_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/**
 * Back on the board in the lane it left. Sends only `archived_at: null`: the database
 * stamps the restore (which restarts the 14-day Done clock) and clears the old place.
 */
export async function restoreWorkItem(id: string): Promise<void> {
  const { error } = await getSupabase().from('work_items').update({ archived_at: null }).eq('id', id);
  if (error) throw error;
}

/** Hard delete; the card's history goes with it. Archive is the keep path. */
export async function deleteWorkItem(id: string): Promise<void> {
  const { error } = await getSupabase().from('work_items').delete().eq('id', id);
  if (error) throw error;
}
