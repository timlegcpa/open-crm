import { beforeEach, describe, expect, it } from 'vitest';
import { fake } from './fakeSupabase';

const db = fake.client;

beforeEach(() => {
  fake.reset();
  fake.state.tables.items = [
    { id: 'a', n: 1, done: true, note: null },
    { id: 'b', n: 2, done: false, note: 'x' },
    { id: 'c', n: 3, done: false, note: null },
    { id: 'd', n: 4, done: true, note: 'y' },
  ];
});

const ids = (r: { data: unknown }) => (r.data as Array<{ id: string }>).map((row) => row.id);

describe('the shared fake client', () => {
  it('filters with lt, is and not as PostgREST does', async () => {
    expect(ids(await db.from('items').select('id').lt('n', 3))).toEqual(['a', 'b']);
    expect(ids(await db.from('items').select('id').is('note', null))).toEqual(['a', 'c']);
    expect(ids(await db.from('items').select('id').is('done', true))).toEqual(['a', 'd']);
    expect(ids(await db.from('items').select('id').not('note', 'is', null))).toEqual(['b', 'd']);
    expect(ids(await db.from('items').select('id').not('id', 'in', '(a,b)'))).toEqual(['c', 'd']);
    expect(ids(await db.from('items').select('id').not('id', 'eq', 'a'))).toEqual(['b', 'c', 'd']);
  });

  it('takes an inclusive range after ordering', async () => {
    const page = await db.from('items').select('id').order('n', { ascending: false }).range(1, 2);
    expect(ids(page)).toEqual(['c', 'b']);
  });

  it('answers a head count with the matching total and no rows', async () => {
    const r = await db.from('items').select('id', { count: 'exact', head: true }).eq('done', false).limit(1);
    expect(r).toEqual({ data: null, error: null, count: 2 });
    const withRows = await db.from('items').select('id', { count: 'exact' }).range(0, 0);
    expect([ids(withRows), withRows.count]).toEqual([['a'], 4]);
  });

  it('records realtime channels and their removal', async () => {
    const statuses: string[] = [];
    const handler = () => {};
    const ch = db.channel('live').on('postgres_changes', { table: 'items' }, handler).subscribe((s) => statuses.push(s));
    expect(fake.state.channels).toEqual([{ name: 'live', config: { table: 'items' }, handler, removed: false }]);
    expect(statuses).toEqual(['SUBSCRIBED']);
    await db.removeChannel(ch);
    expect(fake.state.channels[0].removed).toBe(true);
  });
});
