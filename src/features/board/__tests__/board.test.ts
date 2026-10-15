import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_STAGE_KEYS, DEFAULT_WORK_ITEM_TYPE, type BoardStage, type HistoryEventRow, type WorkItem } from '../api';
import {
  ACTIVITY_UNKNOWN_SUBJECT,
  applyLaneOrders,
  boardActivity,
  boardColumns,
  boardMix,
  boardOverview,
  bucketBoardCards,
  cardDescription,
  cardDescriptionsById,
  daysBetweenISO,
  defaultMoveNote,
  DONE_REASON_CHIP,
  draftAfterNoteSaved,
  emptyColumns,
  EVENT_NOTE_MAX,
  filterWorkItems,
  groupHistoryById,
  isMoveRejected,
  isNoteRequired,
  LANE_TOO_LONG,
  laneOrderAfterDrop,
  laneOrderFits,
  laneSortedBy,
  MAX_LANE_CARDS,
  latestNote,
  MOVE_REASON_CHIPS,
  moveReasonChips,
  NO_NOTE_RECORDED,
  noteFromDetail,
  parseHiddenLanes,
  shapeHistory,
  STAGE_HINTS,
  stageFromOverId,
  stageLabel,
  WORK_ITEM_TITLE_MAX,
  workItemDue,
} from '../board';
import { cardMetaLabel } from '../components/BoardCard';
import { stageTone } from '../stageTone';

const MIGRATION = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/0008_board.sql'), 'utf8');

const workItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w-1',
  contact_id: 'c-1',
  title: 'Send the signed proposal',
  work_item_type: 'task',
  stage: 'waiting',
  priority: 'normal',
  due_date: null,
  lane_position: null,
  archived_at: null,
  created_at: '2026-09-16T00:00:00Z',
  contact: { id: 'c-1', full_name: 'Ada Lovelace', business_name: null },
  ...over,
});

const stageRows = (rows: Partial<BoardStage>[] = []): Map<string, BoardStage> => {
  const seeded: BoardStage[] = [
    { key: 'todo', label: 'To do', colour: null, sort_order: 10 },
    { key: 'waiting', label: 'Waiting', colour: null, sort_order: 20 },
    { key: 'doing', label: 'In progress', colour: null, sort_order: 30 },
    { key: 'done', label: 'Done', colour: null, sort_order: 40 },
  ];
  const map = new Map(seeded.map((r) => [r.key, r]));
  for (const r of rows) map.set(r.key!, { ...map.get(r.key!)!, ...r });
  return map;
};

const event = (over: Partial<HistoryEventRow>): HistoryEventRow => ({
  id: 'e-1',
  work_item_id: 'w-1',
  event_type: 'stage_changed',
  from_value: 'todo',
  to_value: 'waiting',
  created_at: '2026-09-01T12:00:00Z',
  detail: { note: 'Waiting on the client' },
  ...over,
});

describe('the code agrees with 0008_board.sql', () => {
  it('the stage keys are exactly the seeded board_stages, and every key has a hint and a tone', () => {
    const seed = /INSERT INTO public\.board_stages \(key, label, sort_order\) VALUES([\s\S]*?);/.exec(MIGRATION)?.[1] ?? '';
    const keys = [...seed.matchAll(/\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...BOARD_STAGE_KEYS]);
    for (const key of BOARD_STAGE_KEYS) {
      expect(STAGE_HINTS[key]).toBeTruthy();
      expect(stageTone(key).dot).toMatch(/^hsl\(var\(--/);
    }
  });

  it('the default type is the seeded system type and the column default', () => {
    expect(MIGRATION).toContain(`('${DEFAULT_WORK_ITEM_TYPE}', 'Task', 10, true)`);
    expect(MIGRATION).toContain(`work_item_type text NOT NULL DEFAULT '${DEFAULT_WORK_ITEM_TYPE}'`);
  });

  it('the Done hint names the archive interval the server uses', () => {
    const days = /interval '(\d+) days'/.exec(MIGRATION)?.[1];
    expect(STAGE_HINTS.done).toBe(`Archives after ${days} days`);
  });

  it('the history kinds the board reads are the event types the CHECK admits', () => {
    const allowed = /event_type text NOT NULL CHECK \(event_type IN \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? '';
    const types = [...allowed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual(['created', 'stage_changed', 'note_added']);
    expect(shapeHistory(types.map((t, i) => event({ id: `e-${i}`, event_type: t as HistoryEventRow['event_type'] }))).map((e) => e.kind).sort())
      .toEqual(['created', 'move', 'note']);
  });

  it('the lane limit is the bound reorder_board_lane refuses past', () => {
    expect(MIGRATION).toContain(`pg_catalog.cardinality(p_ids) > ${MAX_LANE_CARDS}`);
    expect(LANE_TOO_LONG).toContain('2,000');
  });

  it('the title and note caps are the CHECKs', () => {
    expect(MIGRATION).toContain(`char_length(title) <= ${WORK_ITEM_TITLE_MAX}`);
    expect(MIGRATION).toContain(`char_length(detail ->> 'note') <= ${EVENT_NOTE_MAX}`);
  });
});

describe('boardColumns', () => {
  it('orders the lanes by the owner’s order, with their labels and hints', () => {
    const cols = boardColumns(stageRows([{ key: 'done', sort_order: 5, label: 'Finished', colour: '#22aa77' }]));
    expect(cols.map((c) => [c.stage, c.title, c.hint, c.colour])).toEqual([
      ['done', 'Finished', 'Archives after 14 days', '#22aa77'],
      ['todo', 'To do', 'Not started', null],
      ['waiting', 'Waiting', 'Waiting on someone else', null],
      ['doing', 'In progress', 'Being worked on', null],
    ]);
  });

  it('still draws every lane before the rows load', () => {
    expect(boardColumns(new Map()).map((c) => [c.stage, c.title])).toEqual([
      ['todo', 'Todo'],
      ['waiting', 'Waiting'],
      ['doing', 'Doing'],
      ['done', 'Done'],
    ]);
  });

  it('has 3-5 quick reasons and no em dash in any visible string', () => {
    expect(MOVE_REASON_CHIPS.length).toBeGreaterThanOrEqual(3);
    expect(MOVE_REASON_CHIPS.length).toBeLessThanOrEqual(5);
    const visible = [...Object.values(STAGE_HINTS), ...MOVE_REASON_CHIPS, NO_NOTE_RECORDED, ACTIVITY_UNKNOWN_SUBJECT].join(' ');
    expect(visible).not.toMatch(/\u2014/);
  });
});

describe('stageLabel', () => {
  it('is the current label of a stored key, so a renamed lane renames its history', () => {
    expect(stageLabel('waiting', stageRows([{ key: 'waiting', label: 'On hold' }]))).toBe('On hold');
    expect(stageLabel('some_old_key', stageRows())).toBe('Some old key');
    expect(stageLabel(null, stageRows())).toBe('');
  });
});

describe('moveReasonChips and defaultMoveNote', () => {
  it('leads a move to Done with a Done pill, and leaves the other lanes on the shared pills', () => {
    expect(moveReasonChips('done')).toEqual([DONE_REASON_CHIP, ...MOVE_REASON_CHIPS]);
    for (const stage of ['todo', 'waiting', 'doing'] as const) expect(moveReasonChips(stage)).toEqual(MOVE_REASON_CHIPS);
  });

  it('starts a move to Done with the Done pill selected, and every other lane empty', () => {
    expect(defaultMoveNote('done')).toBe('Done');
    expect(moveReasonChips('done')).toContain(defaultMoveNote('done'));
    for (const stage of ['todo', 'waiting', 'doing'] as const) expect(defaultMoveNote(stage)).toBe('');
  });
});

describe('bucketBoardCards', () => {
  it('puts each card in its stored lane, newest first, and skips archived ones', () => {
    const columns = bucketBoardCards([
      workItem({ id: 'old', created_at: '2026-09-01T00:00:00Z' }),
      workItem({ id: 'new', created_at: '2026-09-20T00:00:00Z' }),
      workItem({ id: 'done', stage: 'done' }),
      workItem({ id: 'gone', archived_at: '2026-09-21T00:00:00Z' }),
    ]);
    expect(columns.waiting.map((c) => c.id)).toEqual(['new', 'old']);
    expect(columns.done.map((c) => c.id)).toEqual(['done']);
    expect(columns.todo).toEqual([]);
  });

  it('breaks a tie on the id, so the order never shuffles', () => {
    const same = '2026-09-01T00:00:00Z';
    const columns = bucketBoardCards([workItem({ id: 'b', created_at: same }), workItem({ id: 'a', created_at: same })]);
    expect(columns.waiting.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('puts placed cards in place order, below every unplaced card', () => {
    const columns = bucketBoardCards([
      workItem({ id: 'p1', lane_position: 1, created_at: '2026-09-30T00:00:00Z' }),
      workItem({ id: 'p0', lane_position: 0 }),
      workItem({ id: 'new-a', created_at: '2026-09-02T00:00:00Z' }),
      workItem({ id: 'new-b', created_at: '2026-09-03T00:00:00Z' }),
    ]);
    expect(columns.waiting.map((c) => c.id)).toEqual(['new-b', 'new-a', 'p0', 'p1']);
  });
});

describe('cardDescription', () => {
  it('names the contact, a business-only contact by its business, and none at all', () => {
    expect(cardDescription(workItem())).toBe('Send the signed proposal for Ada Lovelace');
    expect(cardDescription(workItem({ contact: { id: 'c-2', full_name: '', business_name: 'Acme LLC' } }))).toBe(
      'Send the signed proposal for Acme LLC',
    );
    expect(cardDescription(workItem({ contact_id: null, contact: null }))).toBe('Send the signed proposal');
  });
});

describe('filterWorkItems', () => {
  const items = [
    workItem({ id: 'w-ada', title: 'Renew the lease' }),
    workItem({ id: 'w-acme', title: 'Quarterly review', contact_id: 'c-2', contact: { id: 'c-2', full_name: '', business_name: 'Acme LLC' } }),
    workItem({ id: 'w-none', title: 'Order toner', contact_id: null, contact: null }),
  ];

  it('matches the title or the contact name, case-insensitively', () => {
    expect(filterWorkItems(items, 'ACME', null).map((i) => i.id)).toEqual(['w-acme']);
    expect(filterWorkItems(items, ' toner ', null).map((i) => i.id)).toEqual(['w-none']);
    expect(filterWorkItems(items, '', null)).toHaveLength(3);
  });

  it('narrows to the linked contact and never counts a contact-less card as theirs', () => {
    expect(filterWorkItems(items, '', 'c-1').map((i) => i.id)).toEqual(['w-ada']);
  });
});

describe('history', () => {
  it('reads detail.note and treats null or blank as no note', () => {
    expect(noteFromDetail({ note: 'Called back' })).toBe('Called back');
    expect(noteFromDetail({ note: '  ' })).toBeNull();
    expect(noteFromDetail(null)).toBeNull();
    expect(noteFromDetail('Called back')).toBeNull();
  });

  it('orders newest first, the id breaking a tie, and keeps a null detail as no note', () => {
    const shaped = shapeHistory([
      event({ id: 'e-old', created_at: '2026-08-27T00:00:00Z', detail: null }),
      event({ id: 'e-new', created_at: '2026-09-02T00:00:00Z', detail: { note: 'Ready for review' } }),
      event({ id: 'e-a', created_at: '2026-08-01T00:00:00Z' }),
      event({ id: 'e-b', created_at: '2026-08-01T00:00:00Z' }),
    ]);
    expect(shaped.map((e) => e.id)).toEqual(['e-new', 'e-old', 'e-b', 'e-a']);
    expect(shaped[0].note).toBe('Ready for review');
    expect(shaped[1].note).toBeNull();
  });

  it('shapes a note_added row as a note with no ends', () => {
    const [note] = shapeHistory([event({ event_type: 'note_added', from_value: null, to_value: null, detail: { note: 'Left a voicemail' } })]);
    expect(note).toMatchObject({ kind: 'note', fromValue: null, toValue: null, note: 'Left a voicemail' });
  });

  it('shapes a created row as the lane the card started in, its starting note the latest note', () => {
    const shaped = shapeHistory([
      event({ id: 'e-created', event_type: 'created', from_value: null, to_value: 'done', detail: { note: 'Already sent' } }),
    ]);
    expect(shaped[0]).toMatchObject({ kind: 'created', fromValue: null, toValue: 'done', note: 'Already sent' });
    expect(latestNote(shaped)).toBe('Already sent');
  });

  it('groups by card', () => {
    const grouped = groupHistoryById([event({ id: 'e-a' }), event({ id: 'e-b', work_item_id: 'w-2' }), event({ id: 'e-c', work_item_id: 'w-2' })]);
    expect([...grouped.keys()].sort()).toEqual(['w-1', 'w-2']);
    expect(grouped.get('w-2')).toHaveLength(2);
  });
});

describe('latestNote', () => {
  it('is the note on the most recent event, a bare note included', () => {
    const shaped = shapeHistory([
      event({ id: 'e-move', created_at: '2026-09-01T00:00:00Z', detail: { note: 'Started work' } }),
      event({ id: 'e-note', event_type: 'note_added', from_value: null, to_value: null, created_at: '2026-09-02T00:00:00Z', detail: { note: 'Called back' } }),
    ]);
    expect(latestNote(shaped)).toBe('Called back');
  });

  it('falls back past a move that carried no note, and never shows the placeholder', () => {
    const shaped = shapeHistory([
      event({ id: 'e-old', created_at: '2026-08-27T00:00:00Z', detail: { note: 'Started work' } }),
      event({ id: 'e-new', created_at: '2026-09-02T00:00:00Z', detail: null }),
    ]);
    expect(latestNote(shaped)).toBe('Started work');
    expect(latestNote(shaped)).not.toBe(NO_NOTE_RECORDED);
  });

  it('is null for no history, and for history with no notes', () => {
    expect(latestNote([])).toBeNull();
    expect(latestNote(shapeHistory([event({ detail: null })]))).toBeNull();
    expect(latestNote(shapeHistory([event({ detail: { note: '   ' } })]))).toBeNull();
  });
});

describe('stageFromOverId and the RPC sentinels', () => {
  it('resolves a lane id or a card sitting in a lane', () => {
    const cardStage = new Map([['card-1', 'waiting' as const]]);
    expect(stageFromOverId('doing', cardStage)).toBe('doing');
    expect(stageFromOverId('card-1', cardStage)).toBe('waiting');
    expect(stageFromOverId('missing', cardStage)).toBeNull();
  });

  it('recognises move_rejected and note_required from a PostgREST-shaped error', () => {
    expect(isMoveRejected({ message: 'move_rejected' })).toBe(true);
    expect(isMoveRejected({ message: 'P0002: move_rejected' })).toBe(true);
    expect(isMoveRejected({ message: 'note_required' })).toBe(false);
    expect(isNoteRequired({ message: 'note_required' })).toBe(true);
    expect(isNoteRequired(new Error('nope'))).toBe(false);
    expect(isNoteRequired(null)).toBe(false);
  });
});

describe('boardMix', () => {
  it('counts distinct contacts and every card; a contact-less card counts no one', () => {
    const columns = bucketBoardCards([
      workItem({ id: 'w1', contact_id: 'c1' }),
      workItem({ id: 'w2', contact_id: 'c1', stage: 'done' }),
      workItem({ id: 'w3', contact_id: 'c3' }),
      workItem({ id: 'w4', contact_id: null, contact: null }),
    ]);
    expect(boardMix(columns)).toEqual({ contacts: 2, cards: 4 });
    expect(boardMix(emptyColumns())).toEqual({ contacts: 0, cards: 0 });
  });
});

describe('drop math', () => {
  const lane = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('moving down takes the place of the card it is dropped on', () => {
    expect(laneOrderAfterDrop(lane, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moving up takes the place of the card it is dropped on', () => {
    expect(laneOrderAfterDrop(lane, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('dropped on the lane itself goes to the bottom', () => {
    expect(laneOrderAfterDrop(lane, 'b', 'waiting')).toEqual(['a', 'c', 'd', 'b']);
  });

  it('a drop that changes nothing writes nothing', () => {
    expect(laneOrderAfterDrop(lane, 'b', 'b')).toBeNull();
    expect(laneOrderAfterDrop(lane, 'd', 'waiting')).toBeNull();
  });

  it('a drop point that left the lane saves nothing rather than guessing the bottom', () => {
    expect(laneOrderAfterDrop(lane, 'x', 'gone')).toBeNull();
    expect(laneOrderAfterDrop(lane, 'a', 'gone')).toBeNull();
  });

  it('arriving from another lane goes in just above the card it is over, or at the bottom of the lane', () => {
    expect(laneOrderAfterDrop(lane, 'x', 'c')).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(laneOrderAfterDrop(lane, 'x', 'waiting')).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  it('draws an in-flight order at once, a card that arrived since on top, and leaves other lanes alone', () => {
    const columns = bucketBoardCards([
      workItem({ id: 'a', lane_position: 0 }),
      workItem({ id: 'c', lane_position: 1 }),
      workItem({ id: 'b', lane_position: 2 }),
      workItem({ id: 'n' }),
    ]);
    const drawn = applyLaneOrders(columns, { waiting: ['b', 'a', 'gone', 'c'] });
    expect(drawn.waiting.map((c) => c.id)).toEqual(['n', 'b', 'a', 'c']);
    expect(drawn.todo).toBe(columns.todo);
  });
});

describe('due dates', () => {
  const today = '2026-10-05';

  it('counts whole calendar days, across a daylight-saving change and a month end', () => {
    expect(daysBetweenISO('2026-10-05', '2026-10-05')).toBe(0);
    expect(daysBetweenISO('2026-10-05', '2026-10-04')).toBe(-1);
    expect(daysBetweenISO('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetweenISO('2026-03-07', '2026-03-09')).toBe(2);
  });

  it('is null without a date', () => {
    expect(workItemDue({ due_date: null, stage: 'waiting' }, today)).toBeNull();
  });

  it('labels overdue, today, tomorrow, within a week and later', () => {
    expect(workItemDue({ due_date: '2026-10-04', stage: 'waiting' }, today)?.state).toBe('overdue');
    expect(workItemDue({ due_date: '2026-10-04', stage: 'waiting' }, today)?.label).toMatch(/^Overdue · /);
    expect(workItemDue({ due_date: today, stage: 'waiting' }, today)).toEqual({ state: 'today', label: 'Due today' });
    expect(workItemDue({ due_date: '2026-10-06', stage: 'waiting' }, today)).toEqual({ state: 'soon', label: 'Due tomorrow' });
    expect(workItemDue({ due_date: '2026-10-12', stage: 'waiting' }, today)?.state).toBe('soon');
    expect(workItemDue({ due_date: '2026-10-13', stage: 'waiting' }, today)?.state).toBe('later');
  });

  it('never calls a Done card overdue', () => {
    expect(workItemDue({ due_date: '2026-09-01', stage: 'done' }, today)?.state).toBe('done');
  });
});

describe('laneSortedBy', () => {
  it('sorts by priority, urgent first, ties keeping the lane order', () => {
    const lane = [
      workItem({ id: 'low', priority: 'low' }),
      workItem({ id: 'n0', priority: 'normal' }),
      workItem({ id: 'n1', priority: 'normal' }),
      workItem({ id: 'urg', priority: 'urgent' }),
    ];
    expect(laneSortedBy(lane, 'priority')).toEqual(['urg', 'n0', 'n1', 'low']);
  });

  it('sorts by due date, every undated card below every dated one, wherever they start', () => {
    const lane = [
      workItem({ id: 'u1', due_date: null }),
      workItem({ id: 'u2', due_date: null }),
      workItem({ id: 'd1', due_date: '2026-11-01' }),
      workItem({ id: 'u3', due_date: null }),
      workItem({ id: 'd2', due_date: '2026-10-20' }),
    ];
    expect(laneSortedBy(lane, 'due')).toEqual(['d2', 'd1', 'u1', 'u2', 'u3']);
    expect(laneSortedBy([...lane].reverse(), 'due')).toEqual(['d2', 'd1', 'u3', 'u2', 'u1']);
  });
});

describe('parseHiddenLanes', () => {
  it('keeps only current lanes, in lane order, and survives junk', () => {
    expect(parseHiddenLanes(['done', 'todo', 'filed', 3])).toEqual(['todo', 'done']);
    expect(parseHiddenLanes(null)).toEqual([]);
    expect(parseHiddenLanes('done')).toEqual([]);
    expect(parseHiddenLanes({ done: true })).toEqual([]);
  });
});

describe('boardOverview', () => {
  it('counts open, overdue and due soon, leaves Done out of them, and splits by contact and priority', () => {
    const columns = bucketBoardCards([
      workItem({ id: 'over', stage: 'todo', due_date: '2026-10-01', priority: 'urgent' }),
      workItem({ id: 'soon', stage: 'waiting', due_date: '2026-10-07', contact_id: null, contact: null }),
      workItem({ id: 'today', stage: 'doing', due_date: '2026-10-05', priority: 'low' }),
      workItem({ id: 'later', stage: 'doing', due_date: '2026-12-01', contact_id: 'c-2', contact: { id: 'c-2', full_name: '', business_name: 'Acme LLC' } }),
      workItem({ id: 'done', stage: 'done', due_date: '2026-09-01', priority: 'urgent' }),
    ]);
    const o = boardOverview(columns, boardColumns(stageRows()), '2026-10-05');
    expect(o).toMatchObject({ total: 5, done: 1, open: 4, overdue: 1, dueSoon: 2 });
    expect(o.byPriority.map((p) => [p.value, p.count])).toEqual([
      ['urgent', 1],
      ['normal', 2],
      ['low', 1],
    ]);
    expect(o.byContact).toEqual([
      { id: 'c-1', name: 'Ada Lovelace', count: 2 },
      { id: 'c-2', name: 'Acme LLC', count: 1 },
    ]);
    expect(o.byStage.map((s) => [s.stage, s.count])).toEqual([
      ['todo', 1],
      ['waiting', 1],
      ['doing', 2],
      ['done', 1],
    ]);
  });
});

describe('boardActivity', () => {
  it('orders newest first, names each row, falls back for a card not on the board, and caps the length', () => {
    const descriptions = cardDescriptionsById([workItem()]);
    const feed = boardActivity(
      [
        event({ id: 'a', created_at: '2026-10-01T12:00:00Z' }),
        event({ id: 'b', event_type: 'note_added', from_value: null, to_value: null, detail: { note: 'Called' }, created_at: '2026-10-03T12:00:00Z' }),
        event({ id: 'c', work_item_id: 'gone', created_at: '2026-10-02T12:00:00Z' }),
      ],
      descriptions,
    );
    expect(feed.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(feed[0]).toMatchObject({ kind: 'note', subject: 'Send the signed proposal for Ada Lovelace', note: 'Called' });
    expect(feed[1].subject).toBe(ACTIVITY_UNKNOWN_SUBJECT);
    expect(feed[2]).toMatchObject({ kind: 'move', fromValue: 'todo', toValue: 'waiting' });
    expect(boardActivity([event({ id: 'x' }), event({ id: 'y' })], descriptions, 1)).toHaveLength(1);
  });
});

describe('stageTone', () => {
  it('uses the owner’s colour when set, a theme default per key otherwise, and recesses an unknown key', () => {
    expect(stageTone('waiting').dot).toBe('hsl(var(--attention))');
    expect(stageTone('waiting', '#123456').dot).toBe('#123456');
    expect(stageTone('waiting', '#123456').border).toBe('color-mix(in srgb, #123456 60%, transparent)');
    expect(stageTone('nope').dot).toContain('--muted-foreground');
  });
});

describe('laneOrderFits', () => {
  it('takes a lane of exactly the limit and refuses one more', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `w-${i}`);
    expect(laneOrderFits(ids(MAX_LANE_CARDS))).toBe(true);
    expect(laneOrderFits(ids(MAX_LANE_CARDS + 1))).toBe(false);
    expect(laneOrderFits([])).toBe(true);
  });
});

describe('draftAfterNoteSaved', () => {
  it('clears the draft that was sent, trimmed as it was sent', () => {
    expect(draftAfterNoteSaved({ itemId: 'w-1', text: '  Called back ' }, { id: 'w-1', note: 'Called back' })).toEqual({ itemId: 'w-1', text: '' });
  });

  it('keeps a draft for another card, or a newer draft on the same card', () => {
    const other = { itemId: 'w-2', text: 'Called back' };
    expect(draftAfterNoteSaved(other, { id: 'w-1', note: 'Called back' })).toBe(other);
    const newer = { itemId: 'w-1', text: 'Called back, left a voicemail' };
    expect(draftAfterNoteSaved(newer, { id: 'w-1', note: 'Called back' })).toBe(newer);
  });
});

describe('cardMetaLabel', () => {
  it('counts what happened since the card was added, never its creation row', () => {
    const created = event({ id: 'e-c', event_type: 'created', from_value: null, to_value: 'todo', detail: null, created_at: '2026-09-16T12:00:00Z' });
    const moved = event({ id: 'e-m', created_at: '2026-09-20T12:00:00Z' });
    expect(cardMetaLabel(workItem(), shapeHistory([created]))).toMatch(/^Added /);
    expect(cardMetaLabel(workItem(), shapeHistory([created, moved]))).toMatch(/^1 note · /);
  });
});
