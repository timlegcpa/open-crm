// @vitest-environment node
// supabase/functions/_shared/paging.ts is the Deno twin of src/lib/pagedFetch.ts (edge
// functions cannot import from src/). Both run against the same sources here, and the
// test fails if they ever answer differently: same rows, same requests, same errors.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as browser from '@/lib/pagedFetch';
import * as edge from '../../../supabase/functions/_shared/paging';

type Row = { id: string };
type Answer = { data: Row[] | null; error: unknown };

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}` }));

/** A keyset source over `all` that records every afterId it is asked for. `override` replaces the answer to call N. */
function source(all: Row[], override: Record<number, Answer> = {}) {
  const asked: Array<string | null> = [];
  const fetchPage = async (afterId: string | null): Promise<Answer> => {
    const call = asked.push(afterId) - 1;
    if (call in override) return override[call];
    const start = afterId === null ? 0 : all.findIndex((r) => r.id === afterId) + 1;
    return { data: all.slice(start, start + 1000), error: null };
  };
  return { fetchPage, asked };
}

async function outcome(impl: typeof edge.fetchAllPaged, all: Row[], override?: Record<number, Answer>) {
  const s = source(all, override);
  try {
    return { rows: await impl(s.fetchPage), error: null, asked: s.asked };
  } catch (error) {
    return { rows: null, error, asked: s.asked };
  }
}

const SCENARIOS: Array<[string, Row[], Record<number, Answer>?]> = [
  ['no rows', rows(0)],
  ['one row', rows(1)],
  ['one short page', rows(999)],
  ['exactly one full page', rows(1000)],
  ['one past a page', rows(1001)],
  ['two full pages', rows(2000)],
  ['two and a half pages', rows(2500)],
  ['a page answered with null data', rows(1500), { 1: { data: null, error: null } }],
  ['the first page failing', rows(2500), { 0: { data: null, error: { message: 'first failed' } } }],
  ['a middle page failing', rows(2500), { 1: { data: null, error: { message: 'middle failed' } } }],
  ['an error alongside data', rows(2500), { 2: { data: rows(3), error: { code: '57014' } } }],
];

describe('paging twins', () => {
  it('share the page size, and it is the PostgREST cap', () => {
    expect([edge.PAGE_SIZE, browser.PAGE_SIZE]).toEqual([1000, 1000]);
  });

  it.each(SCENARIOS)('answer identically: %s', async (_label, all, override) => {
    const [a, b] = [await outcome(edge.fetchAllPaged, all, override), await outcome(browser.fetchAllPaged, all, override)];
    expect(a).toEqual(b);
  });

  it('read every row, continuing each request after the last id of the one before', async () => {
    const all = rows(2500);
    const result = await outcome(edge.fetchAllPaged, all);
    expect(result.rows).toEqual(all);
    expect(result.asked).toEqual([null, all[999].id, all[1999].id]);
  });

  it('throw on a failed page instead of returning the rows read so far', async () => {
    const result = await outcome(edge.fetchAllPaged, rows(2500), { 1: { data: null, error: { message: 'middle failed' } } });
    expect(result).toEqual({ rows: null, error: { message: 'middle failed' }, asked: [null, 'id-000999'] });
  });

  it('carry the same function body, comments and blank lines aside', () => {
    const body = (path: string) => {
      const src = readFileSync(path, 'utf8');
      const start = src.indexOf('export async function fetchAllPaged');
      expect(start).toBeGreaterThan(-1);
      return src.slice(start).replace(/\s+/g, ' ').trim();
    };
    expect(body('supabase/functions/_shared/paging.ts')).toBe(body('src/lib/pagedFetch.ts'));
  });
});
