// Page reorder -> field page_index remap for an envelope, pure.
//
// A field's `page_index` is the 0-based position of its page within the non-deleted
// pages sorted by `order`: the contract the placer, planMerge (`final_index`) and the
// finalize stamp all share. Reordering or deleting a page shifts those positions, so
// fields are remapped or deleted to keep each signature on the page it was drawn on.
// esign-reorder-pages computes the remap here and applies it with the pages in one
// transaction (esign_apply_page_reorder).

export interface ReorderPageState {
  id: string;
  order: number;
  deleted: boolean;
}

export interface ReorderOperation {
  page_id: string;
  order?: number;
  deleted?: boolean;
}

export interface ReorderField {
  id: string;
  page_index: number;
}

export interface FieldRemapResult {
  updates: Array<{ id: string; page_index: number }>;
  deletes: string[];
}

/**
 * 0-based position of each non-deleted page within the order-sorted sequence,
 * keyed by page id. Mirrors planMerge / visiblePages exactly.
 */
function positionsByPageId(pages: ReorderPageState[]): Map<string, number> {
  const positions = new Map<string, number>();
  pages
    .filter((p) => !p.deleted)
    .sort((a, b) => a.order - b.order)
    .forEach((p, i) => positions.set(p.id, i));
  return positions;
}

/**
 * Given the current full page set, the reorder operations about to be applied,
 * and the envelope's fields, return which fields need a new page_index and
 * which must be deleted.
 *
 * Rule: a field survives — and is remapped to its page's new position — iff the
 * page it sits on survives the reorder; otherwise the field is deleted. A field
 * whose page_index no longer maps to any live page (already orphaned by legacy
 * data) is treated as "page gone" and deleted too.
 *
 * page_index carries no DB uniqueness constraint, so callers may apply the
 * returned updates in any order without transient-collision concerns.
 */
export function remapFieldsForReorder(
  pages: ReorderPageState[],
  operations: ReorderOperation[],
  fields: ReorderField[],
): FieldRemapResult {
  const opByPageId = new Map<string, ReorderOperation>();
  for (const op of operations) opByPageId.set(op.page_id, op);

  const oldPositions = positionsByPageId(pages);
  const pageIdByOldPosition = new Map<number, string>();
  for (const [id, position] of oldPositions) pageIdByOldPosition.set(position, id);

  const newPages: ReorderPageState[] = pages.map((p) => {
    const op = opByPageId.get(p.id);
    return {
      id: p.id,
      order: op && op.order !== undefined ? op.order : p.order,
      deleted: op && op.deleted !== undefined ? op.deleted : p.deleted,
    };
  });
  const newPositions = positionsByPageId(newPages);

  const updates: Array<{ id: string; page_index: number }> = [];
  const deletes: string[] = [];
  for (const field of fields) {
    const pageId = pageIdByOldPosition.get(field.page_index);
    if (pageId === undefined) {
      deletes.push(field.id);
      continue;
    }
    const newPosition = newPositions.get(pageId);
    if (newPosition === undefined) {
      deletes.push(field.id);
    } else if (newPosition !== field.page_index) {
      updates.push({ id: field.id, page_index: newPosition });
    }
  }
  return { updates, deletes };
}
