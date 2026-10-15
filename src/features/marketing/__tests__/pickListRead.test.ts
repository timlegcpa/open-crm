import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { PAGE_SIZE } from '@/lib/pagedFetch';
import { listLeadSources } from '../api';

beforeEach(() => fake.reset());

const source = (i: number, sort_order: number) => ({
  key: `src_${String(i).padStart(5, '0')}`,
  label: `Source ${i}`,
  colour: null,
  sort_order,
  is_active: true,
  is_system: false,
});

describe('the marketing pick-list reads', () => {
  // One unpaged select stops at PostgREST's 1,000-row cap without a word; a source past it
  // would then show as its raw key on the page.
  it('reads past one page, keyset-paged on key, then puts the list in display order', async () => {
    const total = PAGE_SIZE + 5;
    // Stored out of key order, and display order runs backwards against the key, so both
    // the paging order and the final sort are visible.
    fake.state.tables.lead_sources = Array.from({ length: total }, (_, i) => source(i, total - i)).reverse();
    const rows = await listLeadSources();
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.key)).size).toBe(total);
    expect(rows[0].key).toBe(`src_${String(total - 1).padStart(5, '0')}`);
    const reads = fake.calls('lead_sources', 'select');
    expect(reads).toHaveLength(2);
    expect(reads[0].filters).toEqual([]);
    expect(reads[1].filters).toContainEqual({ type: 'gt', column: 'key', value: `src_${String(PAGE_SIZE - 1).padStart(5, '0')}` });
  });

  it('breaks a sort_order tie on key', async () => {
    fake.state.tables.lead_sources = [source(2, 1), source(1, 1), source(0, 0)];
    expect((await listLeadSources()).map((r) => r.key)).toEqual(['src_00000', 'src_00001', 'src_00002']);
  });

  it('fails loudly on a row of the wrong shape', async () => {
    fake.state.tables.lead_sources = [{ ...source(0, 0), sort_order: 'first' }];
    await expect(listLeadSources()).rejects.toThrow();
  });
});
