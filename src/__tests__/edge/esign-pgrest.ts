/**
 * The slice of supabase-js the e-signature functions call (EsignDb), run against a PGlite
 * database built from the real migrations, as service_role, the way PostgREST runs it:
 *
 *   - rows travel as JSON (to_jsonb), so a timestamp is an ISO string, numeric a number,
 *     bytea '\x..' hex and inet canonical text, as PostgREST answers them;
 *   - written values go through jsonb_populate_record(set), as PostgREST converts a JSON
 *     body, so a wrong column name or type is a Postgres error;
 *   - an RPC is called with NAMED arguments converted by each parameter's declared type;
 *   - a Uint8Array value is refused outright: supabase-js would serialise it as an object
 *     and corrupt the row (functions write bytea with toByteaHex).
 *
 * Embedded resources (`contact:contacts(...)`) are not supported and throw: the functions
 * read related rows with a second query.
 */
import type { PGlite } from '@electric-sql/pglite';
import type {
  DbResponse,
  EsignDb,
  MutationQuery,
  Row,
  SelectQuery,
  TableQuery,
} from '../../../supabase/functions/esign-finalize-envelope/lib/db';

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  const bare = name.trim().replace(/^"(.*)"$/, '$1');
  if (!IDENT.test(bare)) throw new Error(`esign-pgrest: not a column name: ${name}`);
  return `"${bare}"`;
}

function assertJsonValue(value: unknown, where: string): void {
  if (value instanceof Uint8Array) throw new Error(`esign-pgrest: ${where} is a Uint8Array; write bytea with toByteaHex`);
  if (value instanceof Date) throw new Error(`esign-pgrest: ${where} is a Date; send an ISO string`);
  if (Array.isArray(value)) value.forEach((v, i) => assertJsonValue(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${where}.${k}`);
}

function scalarParam(value: unknown, where: string): unknown {
  assertJsonValue(value, where);
  if (value !== null && typeof value === 'object') throw new Error(`esign-pgrest: ${where} must be a scalar`);
  return value;
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

type FilterFn = (p: Params) => string;

interface PgError {
  message: string;
  code: string;
}

function asError(err: unknown): PgError {
  const e = err as { message?: string; code?: string };
  return { message: e.message ?? String(err), code: e.code ?? 'XX000' };
}

function projection(columns: string | undefined): string {
  if (columns === undefined || columns.trim() === '*') return 'to_jsonb(t.*)';
  if (/[():!]/.test(columns)) throw new Error(`esign-pgrest: embedded resources are not supported: ${columns}`);
  const cols = columns.split(',').map((c) => c.trim()).filter(Boolean);
  return `jsonb_build_object(${cols.map((c) => `'${ident(c).slice(1, -1)}', t.${ident(c)}`).join(', ')})`;
}

export function pgrestClient(db: PGlite): EsignDb {
  async function run<T>(sql: string, params: unknown[]): Promise<T[]> {
    let rows: T[] = [];
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      rows = (await tx.query<T>(sql, params)).rows;
    });
    return rows;
  }

  function filterMethods<Self>(filters: FilterFn[], self: () => Self) {
    const add = (f: FilterFn) => {
      filters.push(f);
      return self();
    };
    return {
      eq: (c: string, v: unknown) => add((p) => `t.${ident(c)} = ${p.add(scalarParam(v, c))}`),
      neq: (c: string, v: unknown) => add((p) => `t.${ident(c)} <> ${p.add(scalarParam(v, c))}`),
      gt: (c: string, v: unknown) => add((p) => `t.${ident(c)} > ${p.add(scalarParam(v, c))}`),
      gte: (c: string, v: unknown) => add((p) => `t.${ident(c)} >= ${p.add(scalarParam(v, c))}`),
      lt: (c: string, v: unknown) => add((p) => `t.${ident(c)} < ${p.add(scalarParam(v, c))}`),
      lte: (c: string, v: unknown) => add((p) => `t.${ident(c)} <= ${p.add(scalarParam(v, c))}`),
      in: (c: string, vs: readonly unknown[]) =>
        add((p) => `t.${ident(c)}::text = ANY(${p.add(vs.map((v) => String(scalarParam(v, c))))}::text[])`),
      is: (c: string, v: null | boolean) => add(() => `t.${ident(c)} IS ${v === null ? 'NULL' : v ? 'TRUE' : 'FALSE'}`),
      ilike: (c: string, pattern: string) => add((p) => `t.${ident(c)} ILIKE ${p.add(scalarParam(pattern, c))}`),
      not: (c: string, op: 'is', v: null) => {
        if (op !== 'is' || v !== null) throw new Error('esign-pgrest: only not(column, "is", null) is supported');
        return add(() => `t.${ident(c)} IS NOT NULL`);
      },
    };
  }

  const where = (filters: FilterFn[], p: Params) => (filters.length ? ` WHERE ${filters.map((f) => f(p)).join(' AND ')}` : '');

  function selectQuery(table: string, columns: string, opts: { count?: 'exact'; head?: boolean } = {}): SelectQuery {
    const filters: FilterFn[] = [];
    const orders: string[] = [];
    let limit: number | null = null;
    const exec = async (): Promise<DbResponse<Row[] | null>> => {
      const p = new Params();
      const w = where(filters, p);
      try {
        let count: number | null = null;
        if (opts.count === 'exact') {
          const [c] = await run<{ c: number }>(`SELECT count(*)::int AS c FROM public.${ident(table)} AS t${w}`, p.values);
          count = c.c;
          if (opts.head) return { data: null, error: null, count };
        }
        const order = orders.length ? ` ORDER BY ${orders.join(', ')}` : '';
        const lim = limit === null ? '' : ` LIMIT ${limit}`;
        const rows = await run<{ r: Row }>(`SELECT ${projection(columns)} AS r FROM public.${ident(table)} AS t${w}${order}${lim}`, p.values);
        return { data: rows.map((r) => r.r), error: null, count };
      } catch (err) {
        return { data: null, error: asError(err), count: null };
      }
    };
    const single = (allowNone: boolean) => async (): Promise<DbResponse<Row | null>> => {
      const res = await exec();
      if (res.error) return { data: null, error: res.error };
      const rows = res.data ?? [];
      if (rows.length > 1 || (!allowNone && rows.length === 0)) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      }
      return { data: rows[0] ?? null, error: null };
    };
    const q: SelectQuery = {
      ...filterMethods<SelectQuery>(filters, () => q),
      order(column, options = {}) {
        orders.push(`t.${ident(column)} ${options.ascending === false ? 'DESC' : 'ASC'}`);
        return q;
      },
      limit(n) {
        if (!Number.isInteger(n) || n < 0) throw new Error('esign-pgrest: bad limit');
        limit = n;
        return q;
      },
      maybeSingle: () => ({ then: (a, b) => single(true)().then(a, b) }),
      single: () => ({ then: (a, b) => single(false)().then(a, b) }),
      then: (a, b) => exec().then(a, b),
    };
    return q;
  }

  function mutation(
    build: (p: Params, w: string, returning: string) => string,
    opts: { count?: boolean } = {},
  ): MutationQuery {
    const filters: FilterFn[] = [];
    const exec = async (columns: string | null): Promise<DbResponse<Row[] | null>> => {
      const p = new Params();
      const w = where(filters, p);
      try {
        const ret = columns === null ? ' RETURNING 1 AS r' : ` RETURNING ${projection(columns)} AS r`;
        const rows = await run<{ r: Row }>(build(p, w, ret), p.values);
        return { data: columns === null ? null : rows.map((r) => r.r), error: null, count: opts.count ? rows.length : null };
      } catch (err) {
        return { data: null, error: asError(err), count: null };
      }
    };
    const m: MutationQuery = {
      ...filterMethods<MutationQuery>(filters, () => m),
      select(columns = '*') {
        const s = selectFromMutation(() => exec(columns));
        return s;
      },
      then: (a, b) => exec(null).then((res) => ({ data: null, error: res.error, count: res.count }) as DbResponse<null>).then(a, b),
    };
    return m;
  }

  /** The select() after a write: its rows, with maybeSingle/single on top. No more filters. */
  function selectFromMutation(exec: () => Promise<DbResponse<Row[] | null>>): SelectQuery {
    const refuse = () => {
      throw new Error('esign-pgrest: filter after select() on a write is not supported');
    };
    const single = (allowNone: boolean) => async (): Promise<DbResponse<Row | null>> => {
      const res = await exec();
      if (res.error) return { data: null, error: res.error };
      const rows = res.data ?? [];
      if (rows.length > 1 || (!allowNone && rows.length === 0)) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      }
      return { data: rows[0] ?? null, error: null };
    };
    const s = {
      eq: refuse, neq: refuse, gt: refuse, gte: refuse, lt: refuse, lte: refuse, in: refuse, is: refuse, ilike: refuse, not: refuse,
      order: refuse, limit: refuse,
      maybeSingle: () => ({ then: (a: never, b: never) => single(true)().then(a, b) }),
      single: () => ({ then: (a: never, b: never) => single(false)().then(a, b) }),
      then: (a: never, b: never) => exec().then(a, b),
    };
    return s as unknown as SelectQuery;
  }

  function rowsParam(values: Row | Row[]): { keys: string[]; json: string } {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0) throw new Error('esign-pgrest: empty insert');
    list.forEach((r, i) => assertJsonValue(r, `row ${i}`));
    const keys = [...new Set(list.flatMap((r) => Object.keys(r)))].map(ident);
    return { keys, json: JSON.stringify(list) };
  }

  function table(name: string): TableQuery {
    const t = `public.${ident(name)}`;
    return {
      select: (columns, opts) => selectQuery(name, columns, opts),
      insert(values) {
        const { keys, json } = rowsParam(values);
        return mutation((p, _w, ret) =>
          `INSERT INTO ${t} AS t (${keys.join(', ')}) SELECT ${keys.join(', ')} FROM jsonb_populate_recordset(NULL::${t}, ${p.add(json)}::jsonb)${ret}`);
      },
      upsert(values, opts = {}) {
        const { keys, json } = rowsParam(values);
        const target = (opts.onConflict ?? 'id').split(',').map(ident).join(', ');
        const action = opts.ignoreDuplicates
          ? 'DO NOTHING'
          : `DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`;
        return mutation((p, _w, ret) =>
          `INSERT INTO ${t} AS t (${keys.join(', ')}) SELECT ${keys.join(', ')} FROM jsonb_populate_recordset(NULL::${t}, ${p.add(json)}::jsonb) ON CONFLICT (${target}) ${action}${ret}`);
      },
      update(values, opts = {}) {
        assertJsonValue(values, 'update');
        const keys = Object.keys(values).map(ident);
        if (keys.length === 0) throw new Error('esign-pgrest: empty update');
        return mutation((p, w, ret) => {
          const json = p.add(JSON.stringify(values));
          return `UPDATE ${t} AS t SET (${keys.join(', ')}) = (SELECT ${keys.map((k) => `x.${k}`).join(', ')} FROM jsonb_populate_record(NULL::${t}, ${json}::jsonb) AS x)${w}${ret}`;
        }, { count: opts.count === 'exact' });
      },
      delete(opts = {}) {
        return mutation((_p, w, ret) => `DELETE FROM ${t} AS t${w}${ret}`, { count: opts.count === 'exact' });
      },
    };
  }

  const signatures = new Map<string, { names: string[]; types: string[]; returnsSet: boolean }>();

  async function signature(fn: string) {
    const cached = signatures.get(fn);
    if (cached) return cached;
    const res = await db.query<{ names: string[] | null; types: string[]; retset: boolean }>(
      `SELECT p.proargnames AS names,
              ARRAY(SELECT format_type(a, NULL) FROM unnest(p.proargtypes) a) AS types,
              p.proretset AS retset
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1`,
      [fn],
    );
    if (res.rows.length !== 1) throw new Error(`esign-pgrest: ${fn} has ${res.rows.length} definitions`);
    const row = res.rows[0];
    const sig = { names: row.names ?? [], types: row.types, returnsSet: row.retset };
    signatures.set(fn, sig);
    return sig;
  }

  return {
    from: table,
    rpc(fn, args = {}) {
      const exec = async (): Promise<DbResponse<unknown>> => {
        if (!IDENT.test(fn)) throw new Error(`esign-pgrest: bad function ${fn}`);
        assertJsonValue(args, 'rpc args');
        try {
          const sig = await signature(fn);
          const p = new Params();
          const parts = Object.entries(args).map(([name, value]) => {
            const i = sig.names.indexOf(name);
            if (i < 0) throw Object.assign(new Error(`function ${fn} has no parameter ${name}`), { code: 'PGRST202' });
            const type = sig.types[i];
            let expr: string;
            if (value === null || value === undefined) expr = `NULL::${type}`;
            else if (type === 'jsonb' || type === 'json') expr = `${p.add(JSON.stringify(value))}::${type}`;
            else if (type.endsWith('[]')) expr = `ARRAY(SELECT jsonb_array_elements_text(${p.add(JSON.stringify(value))}::jsonb))::${type}`;
            else expr = `${p.add(String(value))}::${type}`;
            return `${ident(name).slice(1, -1)} => ${expr}`;
          });
          const call = `public.${fn}(${parts.join(', ')})`;
          const sql = sig.returnsSet
            ? `SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS r FROM ${call} AS x`
            : `SELECT to_jsonb(${call}) AS r`;
          const rows = await run<{ r: unknown }>(sql, p.values);
          return { data: rows[0]?.r ?? null, error: null };
        } catch (err) {
          return { data: null, error: asError(err) };
        }
      };
      return { then: (a, b) => exec().then(a, b) };
    },
  };
}
