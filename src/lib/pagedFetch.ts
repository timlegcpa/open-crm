/**
 * PostgREST caps every response at 1,000 rows and says nothing when it does. A list
 * that can grow past that must be read page by page until a short page comes back.
 */
export const PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * Keyset paging on `id`. `fetchPage(afterId)` must return the next PAGE_SIZE rows
 * ordered by id ascending with id greater than `afterId` (no lower bound when null);
 * see `listContacts` for the query shape. Any page error throws: a partial list is
 * never returned as if it were the whole one.
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
