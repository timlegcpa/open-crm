/**
 * Run one async operation over many items, guarding each on its own.
 *
 * A bare `for … await` aborts the whole run on the first rejection: the items
 * after it are silently untouched, and the caller cannot tell which ones ran.
 * The bulk delete, move-to-shared and review operations in the owner explorer
 * and the bulk delete / move on the portal documents page go through this so
 * the outcome is a tally, never a guess. (The admin BulkMoveDialog loops over
 * per-item handlers that catch and toast their own failures, so it cannot
 * abort and reports nothing to tally.)
 */
export type BulkResult = { ok: number; failed: number; firstError: unknown };

export async function runBulk<T>(
  items: readonly T[],
  op: (item: T) => Promise<void>,
): Promise<BulkResult> {
  let ok = 0;
  let failed = 0;
  let firstError: unknown = null;
  for (const item of items) {
    try {
      await op(item);
      ok++;
    } catch (err) {
      failed++;
      if (firstError === null) firstError = err;
    }
  }
  return { ok, failed, firstError };
}
