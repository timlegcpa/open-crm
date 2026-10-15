import type { PageRow, ReorderOp } from '../contract';

/**
 * The reorder sent after a drag: EVERY live page at its new index, 0..n-1. Sending only the
 * pages that moved collides with the gap a deleted page leaves in the stored orders.
 */
export function reorderOperations(liveInNewOrder: readonly Pick<PageRow, 'id'>[]): ReorderOp[] {
  return liveInNewOrder.map((p, idx) => ({ page_id: p.id, order: idx }));
}
