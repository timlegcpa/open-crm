// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchAllPaged, PAGE_SIZE, type PageResult } from '@/lib/pagedFetch';

type Row = { id: string };

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}` }));
}

/** A keyset source over `all`: the next PAGE_SIZE rows with id > afterId. */
function source(all: Row[], failOnCall?: number) {
  return vi.fn(async (afterId: string | null): Promise<PageResult<Row>> => {
    const call = source.calls++;
    if (call === failOnCall) return { data: null, error: { message: 'page failed' } };
    const start = afterId === null ? 0 : all.findIndex((r) => r.id === afterId) + 1;
    return { data: all.slice(start, start + PAGE_SIZE), error: null };
  });
}
source.calls = 0;

describe('fetchAllPaged', () => {
  for (const [n, pages] of [[0, 1], [1000, 2], [1001, 2], [2500, 3]] as const) {
    it(`returns all ${n} rows in ${pages} request(s), each continuing after the last id`, async () => {
      source.calls = 0;
      const all = rows(n);
      const fetchPage = source(all);
      const result = await fetchAllPaged(fetchPage);
      expect(result).toEqual(all);
      expect(fetchPage).toHaveBeenCalledTimes(pages);
      expect(fetchPage.mock.calls[0][0]).toBeNull();
      for (let p = 1; p < pages; p++) {
        expect(fetchPage.mock.calls[p][0]).toBe(all[p * PAGE_SIZE - 1].id);
      }
    });
  }

  it('throws when a middle page fails instead of returning the rows read so far', async () => {
    source.calls = 0;
    const fetchPage = source(rows(2500), 1);
    await expect(fetchAllPaged(fetchPage)).rejects.toEqual({ message: 'page failed' });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('never asks for more than 1,000 rows at a time', () => {
    expect(PAGE_SIZE).toBe(1000);
  });
});
