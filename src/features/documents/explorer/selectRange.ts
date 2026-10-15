/**
 * Shift-click selection over a listing, as other lists select. Everything from the last clicked
 * row (the anchor) to this one is added to the selection, in the order the rows
 * are drawn. With no anchor in this listing it falls back to a single toggle.
 */
export function selectRange(
  prev: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  order: readonly string[],
): Set<string> {
  const next = new Set(prev);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from === -1 || to === -1) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) next.add(order[i]);
  return next;
}
