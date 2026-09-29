/**
 * In-memory Postgres (PGlite) with the pieces of Supabase the migrations depend on:
 * the anon / authenticated / service_role roles, and an `auth` schema whose uid() and
 * jwt() read the same `request.jwt.claims` setting PostgREST sets on a real project.
 *
 * Every test database is built from the real migration files, in filename order, so
 * a test proves the SQL that ships.
 */
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations');

const SUPABASE_SHIM = `
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE auth.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL
);

-- Same bodies as Supabase's own auth.uid() / auth.jwt().
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

-- Supabase grants everything created in public to all three API roles by default, so a
-- migration that forgets a REVOKE is open on a real project. Reproduce that here, so the
-- same omission fails a test instead of passing one.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- Present on every Supabase project; migrations add their realtime tables to it.
CREATE PUBLICATION supabase_realtime;
`;

export interface Principal {
  role: 'anon' | 'authenticated' | 'service_role';
  claims?: Record<string, unknown>;
}

export const anon: Principal = { role: 'anon' };
export const service: Principal = { role: 'service_role' };

/** A signed-in user. `aal` defaults to aal1; `iat` to now. */
export function user(id: string, opts: { aal?: 'aal1' | 'aal2'; iat?: number; appRole?: string } = {}): Principal {
  return {
    role: 'authenticated',
    claims: {
      sub: id,
      role: 'authenticated',
      aal: opts.aal ?? 'aal1',
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      app_metadata: opts.appRole ? { role: opts.appRole } : {},
    },
  };
}

export async function createDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    } catch (err) {
      throw new Error(`migration ${f} failed: ${(err as Error).message}`);
    }
  }
  return db;
}

type Tx = Parameters<Parameters<PGlite['transaction']>[0]>[0];

/**
 * Run `fn` as `who` inside a transaction that is always rolled back, so every call
 * sees the database exactly as the fixtures left it.
 */
export async function session<T>(db: PGlite, who: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(who.claims ?? { role: who.role })]);
    await tx.exec(`SET LOCAL ROLE ${who.role}`);
    try {
      out = await fn(tx);
    } finally {
      await tx.rollback();
    }
  });
  return out;
}

/** One statement as `who`, rolled back. */
export async function as<T = Record<string, unknown>>(
  db: PGlite,
  who: Principal,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return session(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Rows of `table` that `who` can see, optionally narrowed by a WHERE clause. */
export async function count(db: PGlite, who: Principal, table: string, where = 'true'): Promise<number> {
  const rows = await as<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`);
  return rows[0].n;
}

/**
 * Inside a `session`: run one statement under a savepoint and resolve to its error
 * message, or null when it succeeded. A failure does not abort the rest of the session.
 */
export async function tryIn(tx: Tx, sql: string, params: unknown[] = []): Promise<string | null> {
  await tx.exec('SAVEPOINT try_in');
  try {
    await tx.query(sql, params);
    await tx.exec('RELEASE SAVEPOINT try_in');
    return null;
  } catch (err) {
    await tx.exec('ROLLBACK TO SAVEPOINT try_in');
    return (err as Error).message;
  }
}

/** Like `as`, but resolves to the Postgres error message, or null when it succeeded. */
export async function errorOf(db: PGlite, who: Principal, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await as(db, who, sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
