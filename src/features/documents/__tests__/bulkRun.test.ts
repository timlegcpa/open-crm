import { describe, it, expect } from 'vitest';
import { runBulk } from '../lib/bulkRun';

describe('runBulk', () => {
  it('keeps going after a rejection and tallies the outcome', async () => {
    const seen: number[] = [];
    const result = await runBulk([1, 2, 3, 4], async (n) => {
      seen.push(n);
      if (n === 2) throw new Error('boom');
    });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(result.ok).toBe(3);
    expect(result.failed).toBe(1);
    expect((result.firstError as Error).message).toBe('boom');
  });

  it('reports the FIRST error when several fail', async () => {
    const result = await runBulk(['a', 'b', 'c'], async (s) => {
      if (s !== 'a') throw new Error(`fail-${s}`);
    });
    expect(result).toMatchObject({ ok: 1, failed: 2 });
    expect((result.firstError as Error).message).toBe('fail-b');
  });

  it('returns zeros and a null error for an empty list', async () => {
    const result = await runBulk([], async () => {});
    expect(result).toEqual({ ok: 0, failed: 0, firstError: null });
  });
});
