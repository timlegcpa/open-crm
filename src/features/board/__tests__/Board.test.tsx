import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardStage, WorkItem, WorkItemType } from '../api';

// The board's own wiring, with its reads and writes stubbed: the network and the database
// rules are the db suite's; here it is what the board does with a slow or failed answer.
const h = vi.hoisted(() => ({
  history: { status: 'success' as 'pending' | 'error' | 'success', refetch: vi.fn() },
  laneLimit: null as number | null,
  addNote: vi.fn(),
  reorder: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock('@/components/ui/sonner', () => ({ toast: h.toast }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  addWorkItemNote: h.addNote,
  reorderLane: h.reorder,
}));

// The real bound is 2,000 (board.test.ts pins it to the SQL); a small stand-in keeps the
// lane renderable while proving the board asks before it writes.
vi.mock('../board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../board')>();
  return {
    ...actual,
    laneOrderFits: (order: readonly string[]) => (h.laneLimit === null ? actual.laneOrderFits(order) : order.length <= h.laneLimit),
  };
});

vi.mock('../hooks', async () => {
  const { boardColumns } = await import('../board');
  const stages: BoardStage[] = [
    { key: 'todo', label: 'To do', colour: null, sort_order: 10 },
    { key: 'waiting', label: 'Waiting', colour: null, sort_order: 20 },
    { key: 'doing', label: 'In progress', colour: null, sort_order: 30 },
    { key: 'done', label: 'Done', colour: null, sort_order: 40 },
  ];
  const rows = new Map(stages.map((s) => [s.key, s]));
  const columns = boardColumns(rows);
  const types: WorkItemType[] = [{ key: 'task', label: 'Task', colour: null, sort_order: 10, is_active: true, is_system: true }];
  const typeRows = new Map(types.map((t) => [t.key, t]));
  return {
    useBoardStages: () => ({ rows, columns, query: { data: stages } }),
    useWorkItemTypes: () => ({ rows: typeRows, query: { data: types } }),
    useBoardHistory: () => ({
      data: h.history.status === 'success' ? [] : undefined,
      status: h.history.status,
      isPending: h.history.status === 'pending',
      isError: h.history.status === 'error',
      refetch: h.history.refetch,
    }),
  };
});

import { LANE_TOO_LONG } from '../board';
import { Board } from '../components/Board';

const card = (id: string, priority: WorkItem['priority']): WorkItem => ({
  id,
  contact_id: null,
  title: `Card ${id}`,
  work_item_type: 'task',
  stage: 'todo',
  priority,
  due_date: null,
  lane_position: null,
  archived_at: null,
  created_at: `2026-09-0${id === 'a' ? 1 : id === 'b' ? 2 : 3}T00:00:00Z`,
  contact: null,
});
const ITEMS = [card('a', 'low'), card('b', 'normal'), card('c', 'urgent')];

function renderBoard(openItemId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ui = (id: string | null) => (
    <QueryClientProvider client={client}>
      <Board items={ITEMS} laneItems={ITEMS} hiddenLanes={[]} onHideLane={vi.fn()} onShowLane={vi.fn()} onAddToLane={vi.fn()} openItemId={id} />
    </QueryClientProvider>
  );
  const view = render(ui(openItemId));
  return { ...view, open: (id: string) => view.rerender(ui(id)) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.history.status = 'success';
  h.laneLimit = null;
  h.reorder.mockResolvedValue(undefined);
});

describe('a lane sort and the lane limit', () => {
  const sortByPriority = () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'To do options' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort by priority' }));
  };

  it('saves the sorted lane when it fits', async () => {
    renderBoard();
    sortByPriority();
    await waitFor(() => expect(h.reorder).toHaveBeenCalledWith('todo', ['c', 'b', 'a']));
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('refuses a lane over the limit with a toast, and writes nothing', () => {
    h.laneLimit = 2;
    renderBoard();
    sortByPriority();
    expect(h.toast.error).toHaveBeenCalledWith(LANE_TOO_LONG);
    expect(h.reorder).not.toHaveBeenCalled();
  });
});

describe('the history dialog', () => {
  it('says the history read failed, offers a retry, and never claims the card has no history', () => {
    h.history.status = 'error';
    renderBoard('a');
    expect(screen.getByRole('alert')).toHaveTextContent("Could not load this card's history.");
    expect(screen.queryByText('No notes or moves yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.history.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows loading while the read is pending, and the empty state only once it succeeded', () => {
    h.history.status = 'pending';
    const { open } = renderBoard('a');
    expect(screen.getByLabelText('Loading history')).toBeInTheDocument();
    expect(screen.queryByText('No notes or moves yet.')).toBeNull();
    h.history.status = 'success';
    open('a');
    expect(screen.getByText('No notes or moves yet.')).toBeInTheDocument();
  });
});

describe('the note composer', () => {
  const note = () => screen.getByLabelText('Add a note') as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(note(), { target: { value: text } });
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

  it('clears the draft once its note saved', async () => {
    const save = deferred();
    h.addNote.mockReturnValue(save.promise);
    renderBoard('a');
    type('Called back');
    submit();
    await waitFor(() => expect(h.addNote).toHaveBeenCalledWith('a', 'Called back'));
    await act(async () => save.resolve());
    await waitFor(() => expect(note().value).toBe(''));
  });

  it('a slow save for one card leaves the draft typed since for another card alone', async () => {
    const save = deferred();
    h.addNote.mockReturnValue(save.promise);
    const { open } = renderBoard('a');
    type('Called back');
    submit();
    open('b');
    type('Draft for b');
    await act(async () => save.resolve());
    await waitFor(() => expect(h.addNote).toHaveBeenCalledTimes(1));
    expect(note().value).toBe('Draft for b');
  });

  it('a slow save leaves a newer draft on the same card alone', async () => {
    const save = deferred();
    h.addNote.mockReturnValue(save.promise);
    renderBoard('a');
    type('Called back');
    submit();
    type('Called back, left a voicemail');
    await act(async () => save.resolve());
    expect(note().value).toBe('Called back, left a voicemail');
  });
});
