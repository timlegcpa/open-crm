// The slice of supabase-js the e-signature functions call, as a structural type, plus the
// helpers that turn a PostgREST answer into a value or a thrown DbFailure.
//
// Every e-sign handler takes an EsignDb (index.ts passes the service client) instead of a
// dozen single-purpose callbacks: the functions run many small queries, and the tests run
// the same handler code against the real migrations through a PostgREST-shaped adapter
// over PGlite (src/__tests__/edge/esign-pgrest.ts), so a wrong column or a broken guard is
// a failing test rather than a fake that agrees with anything.
//
// bytea values travel as the '\x..' hex text PostgREST takes and returns (crypto.ts
// toByteaHex / fromBytea); a Uint8Array would be serialised as an object and corrupt the
// row, so the test adapter refuses one.

import { fetchAllPaged, PAGE_SIZE } from '../../_shared/paging.ts';

export type Row = Record<string, unknown>;

export interface DbError {
  message: string;
  code?: string;
}

export interface DbResponse<T> {
  data: T;
  error: DbError | null;
  count?: number | null;
}

export interface Filterable<Self> {
  eq(column: string, value: unknown): Self;
  neq(column: string, value: unknown): Self;
  gt(column: string, value: unknown): Self;
  gte(column: string, value: unknown): Self;
  lt(column: string, value: unknown): Self;
  lte(column: string, value: unknown): Self;
  in(column: string, values: readonly unknown[]): Self;
  is(column: string, value: null | boolean): Self;
  ilike(column: string, pattern: string): Self;
  /** Only `not(column, 'is', null)` is used. */
  not(column: string, operator: 'is', value: null): Self;
}

export interface SelectQuery extends Filterable<SelectQuery>, PromiseLike<DbResponse<Row[] | null>> {
  order(column: string, options?: { ascending?: boolean }): SelectQuery;
  limit(count: number): SelectQuery;
  maybeSingle(): PromiseLike<DbResponse<Row | null>>;
  single(): PromiseLike<DbResponse<Row | null>>;
}

export interface MutationQuery extends Filterable<MutationQuery>, PromiseLike<DbResponse<null>> {
  select(columns?: string): SelectQuery;
}

export interface TableQuery {
  select(columns: string, options?: { count?: 'exact'; head?: boolean }): SelectQuery;
  insert(values: Row | Row[]): MutationQuery;
  update(values: Row, options?: { count?: 'exact' }): MutationQuery;
  delete(options?: { count?: 'exact' }): MutationQuery;
  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): MutationQuery;
}

export interface EsignDb {
  from(table: string): TableQuery;
  rpc(fn: string, args?: Row): PromiseLike<DbResponse<unknown>>;
}

/** A database call that failed. Its message names the operation and the SQLSTATE only. */
export class DbFailure extends Error {
  constructor(
    readonly op: string,
    readonly code: string | undefined,
  ) {
    super(`${op} failed${code ? ` (${code})` : ''}`);
    this.name = 'DbFailure';
  }
}

/** The SQLSTATE of a returned or thrown database error, when it has one. */
export function pgCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function check<T>(op: string, res: DbResponse<T>): DbResponse<T> {
  if (res.error) throw new DbFailure(op, res.error.code);
  return res;
}

/** Every row the query answers (PostgREST caps an unpaged read at 1,000: page anything that can grow). */
export async function rows<T = Row>(op: string, query: PromiseLike<DbResponse<Row[] | null>>): Promise<T[]> {
  return (check(op, await query).data ?? []) as T[];
}

/** One row or null (maybeSingle). */
export async function maybeOne<T = Row>(op: string, query: PromiseLike<DbResponse<Row | null>>): Promise<T | null> {
  return (check(op, await query).data ?? null) as T | null;
}

/** A write whose answer is not needed. */
export async function run(op: string, query: PromiseLike<DbResponse<unknown>>): Promise<void> {
  check(op, await query);
}

/** The exact count of a `select('id', { count: 'exact', head: true })`. */
export async function countOf(op: string, query: PromiseLike<DbResponse<unknown>>): Promise<number> {
  const res = check(op, await query);
  return typeof res.count === 'number' ? res.count : 0;
}

/** A server function's result. */
export async function call<T = unknown>(db: EsignDb, fn: string, args: Row): Promise<T> {
  return check(`rpc ${fn}`, await db.rpc(fn, args)).data as T;
}

/**
 * Every row of a read that can pass 1,000 rows, keyset-paged on id (_shared/paging.ts).
 * `build` returns the filtered query; the order, page size and id bound are added here,
 * so a caller sorts the result in memory when it needs another order.
 */
export async function allRows<T extends { id: string }>(op: string, build: () => SelectQuery): Promise<T[]> {
  try {
    return await fetchAllPaged<T>(async (afterId) => {
      let q = build().order('id', { ascending: true }).limit(PAGE_SIZE);
      if (afterId) q = q.gt('id', afterId);
      const res = await q;
      return { data: (res.data ?? []) as unknown as T[], error: res.error };
    });
  } catch (err) {
    if (err instanceof DbFailure) throw err;
    throw new DbFailure(op, pgCode(err));
  }
}

/** Sort rows by a timestamp column, then id: the order an audit trail is read in. */
export function byTimeThenId<T extends { id: string; created_at: string }>(a: T, b: T): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
