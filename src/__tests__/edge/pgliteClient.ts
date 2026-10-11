/**
 * The slice of supabase-js the shared edge modules call (rpc, from().insert,
 * from().select().maybeSingle()), run against a PGlite database built from the real
 * migrations, as service_role. A fake would accept any argument name; this one calls
 * functions with NAMED arguments, so a wrong parameter or column name is a Postgres
 * error, exactly as PostgREST would return it.
 */
import type { PGlite } from '@electric-sql/pglite';

const IDENT = /^[a-z_][a-z0-9_]*$/;

interface PgError {
  message: string;
  code: string;
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not an identifier: ${name}`);
  return name;
}

/** Objects travel as JSON text (jsonb); arrays, bytes and scalars as they are. */
function encode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

function asError(err: unknown): PgError {
  const e = err as { message?: string; code?: string };
  return { message: e.message ?? String(err), code: e.code ?? 'XX000' };
}

export interface PgliteServiceClient {
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: PgError | null }>;
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: PgError | null }>;
    select(columns: string): { maybeSingle(): Promise<{ data: unknown; error: PgError | null }> };
  };
}

export function serviceClient(db: PGlite): PgliteServiceClient {
  async function run<T>(sql: string, params: unknown[]): Promise<T[]> {
    let rows: T[] = [];
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      rows = (await tx.query<T>(sql, params)).rows;
    });
    return rows;
  }

  return {
    async rpc(fn, args = {}) {
      const keys = Object.keys(args).map(ident);
      const call = `public.${ident(fn)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      try {
        const rows = await run<{ result: unknown }>(`SELECT ${call} AS result`, keys.map((k) => encode(args[k])));
        return { data: rows[0]?.result ?? null, error: null };
      } catch (err) {
        return { data: null, error: asError(err) };
      }
    },
    from(table) {
      const name = `public.${ident(table)}`;
      return {
        async insert(row) {
          const keys = Object.keys(row).map(ident);
          const sql = `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`;
          try {
            await run(sql, keys.map((k) => encode(row[k])));
            return { error: null };
          } catch (err) {
            return { error: asError(err) };
          }
        },
        select(columns) {
          const cols = columns.split(',').map((c) => ident(c.trim())).join(', ');
          return {
            async maybeSingle() {
              try {
                const rows = await run<Record<string, unknown>>(`SELECT ${cols} FROM ${name} LIMIT 2`, []);
                if (rows.length > 1) return { data: null, error: { message: 'more than one row', code: 'PGRST116' } };
                return { data: rows[0] ?? null, error: null };
              } catch (err) {
                return { data: null, error: asError(err) };
              }
            },
          };
        },
      };
    },
  };
}
