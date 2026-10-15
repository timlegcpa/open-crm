/**
 * In-memory Postgres (PGlite) with the pieces of Supabase the migrations depend on:
 * the anon / authenticated / service_role roles, an `auth` schema whose uid() and
 * jwt() read the same `request.jwt.claims` setting PostgREST sets on a real project,
 * the auth tables migrations read (users, sessions, mfa_factors, mfa_amr_claims), and
 * the `storage` schema (buckets, objects and the path helpers storage policies use).
 *
 * Every test database is built from the real migration files, in filename order, so
 * a test proves the SQL that ships.
 *
 * Not here, because no migration in scope uses it: pgcrypto (gen_random_bytes, digest,
 * crypt), pg_trgm, citext, unaccent and the `extensions` schema. Tokens are hashed in
 * edge functions, not in SQL. A migration that needs one of them must add it here.
 */
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations');

const SUPABASE_SHIM = `
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth: Supabase Auth's tables, cut to the columns migrations read. Every column a
-- test does not name is nullable or defaulted, so INSERT INTO auth.users (id, email)
-- is enough. No API role is granted anything on these tables, as on a real project.
-- ---------------------------------------------------------------------------
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  encrypted_password text,
  phone text UNIQUE,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE auth.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL
);

-- One row per signed-in session; an access token's session_id claim is its id.
-- Deleting the row kills the session's refresh token.
CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz,
  refreshed_at timestamp,
  user_agent text,
  ip inet,
  tag text
);

-- How each session authenticated ('password', 'otp' for a magic link, 'totp', ...).
CREATE TABLE auth.mfa_amr_claims (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  authentication_method text NOT NULL,
  UNIQUE (session_id, authentication_method)
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

-- ---------------------------------------------------------------------------
-- storage: Supabase Storage's schema. Supabase grants everything in it to all three
-- API roles and leaves RLS on with no policies, so nothing is reachable until a
-- migration adds a policy for its bucket. Policies on storage.objects are where a
-- bucket's access lives.
-- ---------------------------------------------------------------------------
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  owner_id text,
  public boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX bname ON storage.buckets (name);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id)
);
CREATE UNIQUE INDEX bucketid_objname ON storage.objects (bucket_id, name);
CREATE INDEX name_prefix_search ON storage.objects (name text_pattern_ops);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Supabase Storage's path helpers: 'a/b/c.pdf' -> folders {a,b}, file 'c.pdf', 'pdf'.
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts, 1) - 1];
END
$$;
CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[array_length(_parts, 1)];
END
$$;
CREATE FUNCTION storage.extension(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
  _filename text;
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  SELECT _parts[array_length(_parts, 1)] INTO _filename;
  RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;

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

export interface UserOptions {
  aal?: 'aal1' | 'aal2';
  iat?: number;
  appRole?: string;
  /**
   * The token's session_id claim: the auth.sessions row it belongs to. Every access
   * token Supabase Auth issues carries one, so by default each principal gets its own
   * random id (one device). Pass an id to act as a particular session, or null for a
   * token without the claim.
   */
  sessionId?: string | null;
}

/** A signed-in user. `aal` defaults to aal1; `iat` to now. */
export function user(id: string, opts: UserOptions = {}): Principal {
  const sessionId = opts.sessionId === undefined ? randomUUID() : opts.sessionId;
  return {
    role: 'authenticated',
    claims: {
      sub: id,
      role: 'authenticated',
      aal: opts.aal ?? 'aal1',
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      app_metadata: opts.appRole ? { role: opts.appRole } : {},
      ...(sessionId === null ? {} : { session_id: sessionId }),
    },
  };
}

// ---------------------------------------------------------------------------
// The principals of 0001_core, under the ids seedCore() writes.
// ---------------------------------------------------------------------------

export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const SYSTEM_ID = '00000000-0000-4000-8000-000000000002';

/** No token: what a request with only the anon key runs as. */
export const asAnon: Principal = anon;
/** The service-role key: edge functions. Bypasses RLS, not triggers. */
export const asServer: Principal = service;
/** The owner seedCore() records, signed in without MFA enrolled (aal1 is then enough). */
export const asOwner: Principal = user(OWNER_ID);
/** A portal user. A client only once seedPortalAccount() binds the id to a contact. */
export function asClient(userId: string, opts: Omit<UserOptions, 'appRole'> = {}): Principal {
  return user(userId, opts);
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

function claimsOf(who: Principal): string {
  return JSON.stringify(who.claims ?? { role: who.role });
}

/**
 * Run `fn` as `who` inside a transaction that is always rolled back, so every call
 * sees the database exactly as the fixtures left it.
 */
export async function session<T>(db: PGlite, who: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claimsOf(who)]);
    await tx.exec(`SET LOCAL ROLE ${who.role}`);
    try {
      out = await fn(tx);
    } finally {
      await tx.rollback();
    }
  });
  return out;
}

/**
 * Inside a `session`: from here on, act as `who` (its claims and its role). Use it to
 * set rows up as the server, then try the statement under test as a client.
 */
export async function become(tx: Tx, who: Principal): Promise<void> {
  await tx.exec('RESET ROLE');
  await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claimsOf(who)]);
  await tx.exec(`SET LOCAL ROLE ${who.role}`);
}

/**
 * Inside a `session`: from here on, act as the database superuser (the role migrations
 * run as) with no token, e.g. to seed auth.sessions, which no API role may write.
 */
export async function becomeSuperuser(tx: Tx): Promise<void> {
  await tx.exec('RESET ROLE');
  await tx.query(`SELECT set_config('request.jwt.claims', '', true)`);
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

export interface DbError extends Error {
  code?: string;
}

/**
 * Resolves to the error a refused statement raised, and fails the test when the
 * statement succeeded or failed with a different SQLSTATE. The default, 42501
 * (insufficient_privilege), is what a missing grant, a failed RLS WITH CHECK and this
 * schema's guard triggers all raise. Pass the promise of an `as(...)` or `session(...)`
 * call: each runs in its own rolled-back transaction.
 *
 * An UPDATE or DELETE that RLS filters down to zero rows raises nothing. Assert those
 * with RETURNING and an empty result instead.
 */
export async function expectDenied(promise: Promise<unknown>, code = '42501'): Promise<DbError> {
  let caught: DbError | undefined;
  try {
    await promise;
  } catch (err) {
    caught = err as DbError;
  }
  if (!caught) throw new Error(`expected the statement to be refused with SQLSTATE ${code}, but it succeeded`);
  expect(caught.code, caught.message).toBe(code);
  return caught;
}

// ---------------------------------------------------------------------------
// Seeds. Each writes as the database superuser (the migrations' role), committed.
// ---------------------------------------------------------------------------

/** What `npm run dev:bootstrap` writes: the owner, the system actor and org_profile. */
export async function seedCore(db: PGlite, displayName = 'Example Co'): Promise<void> {
  await db.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, 'owner@example.test'), ($2, 'system@example.test')`,
    [OWNER_ID, SYSTEM_ID],
  );
  await db.query(
    `INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ($1, $2, $3)`,
    [displayName, OWNER_ID, SYSTEM_ID],
  );
}

/** A contact, returning its id. Any contacts column may be set; the rest take defaults. */
export async function seedContact(db: PGlite, fields: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = { first_name: 'Ada', last_name: 'Example', ...fields };
  const columns = Object.keys(row).map((c) => `"${c.replace(/"/g, '""')}"`);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.contacts (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0].id;
}

/**
 * A sign-in user and the portal account that binds it to `contactId` (active unless
 * `status` says otherwise). `asClient(userId)` is then that contact's client.
 */
export async function seedPortalAccount(
  db: PGlite,
  contactId: string,
  opts: { userId?: string; email?: string; status?: 'invited' | 'active' | 'suspended' | 'deactivated' } = {},
): Promise<{ userId: string; accountId: string }> {
  const userId = opts.userId ?? randomUUID();
  const email = opts.email ?? `client-${userId.slice(0, 8)}@example.test`;
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, email]);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [contactId, userId, opts.status ?? 'active', email],
  );
  return { userId, accountId: rows[0].id };
}
