// Deno twin of src/lib/pagedFetch.ts: the same keyset paging, for edge functions,
// which cannot import from src/. src/__tests__/edge/paging.test.ts runs both against
// the same sources and fails if they ever answer differently.
//
// PostgREST caps every response at 1,000 rows and says nothing when it does, so a read
// that can grow past that goes page by page. Keyset on `id` ascending, not .range():
// id is unique, so the order is total (the tiebreaker an order on a non-unique column
// lacks, where rows sharing a value can be skipped or repeated between pages), and a
// row inserted mid-read cannot shift the pages after it.
//
//   const rows = await fetchAllPaged<Row>((afterId) => {
//     let q = db.from('contacts').select('id, first_name').order('id', { ascending: true }).limit(PAGE_SIZE);
//     if (afterId) q = q.gt('id', afterId);
//     return q;
//   });

export const PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * `fetchPage(afterId)` must return the next PAGE_SIZE rows ordered by id ascending with
 * id greater than `afterId` (no lower bound when null). Any page error throws: a partial
 * list is never returned as if it were the whole one.
 */
export async function fetchAllPaged<T extends { id: string }>(
  fetchPage: (afterId: string | null) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await fetchPage(afterId);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    afterId = page[page.length - 1].id;
  }
}
