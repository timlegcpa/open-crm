// @vitest-environment node
/**
 * Schema-wide invariants. Every check reads the catalog of the fully migrated database,
 * so it holds each migration, including the ones written after this file, to the same
 * rules without anyone listing the new tables. A check returns one line per violation;
 * the schema passes when every check returns nothing.
 *
 * Each check is proven by mutations below: a violating object is created inside a
 * rolled-back transaction (never on disk) and the check must name it. A table written
 * by the rules (CONFORMING) must pass every check, so no check passes by flagging
 * nothing or fails by flagging everything.
 *
 * Exceptions live in the allowlists next to the checks, each with its reason.
 */
import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './harness';

type Tx = Parameters<Parameters<PGlite['transaction']>[0]>[0];
type Check = (tx: Tx) => Promise<string[]>;

/** Functions anon may execute: display fields for pages shown before sign-in. */
const ANON_EXECUTE_ALLOWED = ['public.get_org_branding()'];

/**
 * Write policies that look client-writable to check 8 but are not, by `table.policy`.
 * An entry excuses only a reference to get_client_contact_id() or auth.uid(): the
 * policy must still require is_owner() at its top level, or it is reported anyway.
 */
/**
 * SECURITY DEFINER functions a signed-in session may call that write a table without
 * trg_impersonation_read_only, each with its reason. An entry must open with the owner
 * refusal (IF NOT public.is_owner() THEN RAISE) before any write.
 */
const DEFINER_WRITE_EXEMPT: Record<string, string> = {
  'public.retry_job(uuid)': 'owner only: a View-as-client session is a client session, which never passes is_owner()',
};

const IMPERSONATION_EXEMPT: Record<string, string> = {
  'audit_logs.audit_logs_owner_insert':
    'is_owner() gates the insert; auth.uid() only pins user_id to the writer, and a View-as-client session is a client session, which never passes is_owner()',
};

/** SQL: whether the table `rel` carries the View-as-client statement trigger, whole. */
const READ_ONLY_GUARDED = (rel: string) => `EXISTS (
  SELECT 1 FROM pg_trigger tg
  WHERE tg.tgrelid = ${rel}
    AND tg.tgname = 'trg_impersonation_read_only'
    AND tg.tgfoid = 'public.enforce_impersonation_read_only()'::regprocedure
    AND (tg.tgtype & 1) = 0            -- FOR EACH STATEMENT
    AND (tg.tgtype & 2) = 2            -- BEFORE
    AND (tg.tgtype & 28) = 28          -- INSERT (4), DELETE (8) and UPDATE (16)
    AND tg.tgenabled IN ('O', 'A')
    AND tg.tgqual IS NULL
    AND tg.tgattr = ''::int2vector)`;

/**
 * The clauses Postgres actually applies for a policy command, an omitted one read as
 * true: INSERT checks WITH CHECK, DELETE and SELECT check USING, and UPDATE or ALL check
 * both, an omitted WITH CHECK falling back to USING.
 */
function appliedClauses(cmd: string, qual: string | null, chk: string | null): string[] {
  if (cmd === 'a') return [chk ?? 'true'];
  if (cmd === 'd' || cmd === 'r') return [qual ?? 'true'];
  return [qual ?? 'true', chk ?? qual ?? 'true'];
}

// ---------------------------------------------------------------------------
// Reading rendered policy expressions. Every check runs with search_path = '', so
// pg_get_expr schema-qualifies function names (public.is_owner(), auth.uid()).
// ---------------------------------------------------------------------------

/** Walks `s`, calling `visit` on every character outside quoted text with its paren depth. */
function scan(s: string, visit: (i: number, depth: number) => number | void): void {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1); // a doubled quote reads as two adjacent quoted runs
      i = end < 0 ? s.length : end;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const skip = visit(i, depth);
    if (typeof skip === 'number') i = skip;
  }
}

/** Drops parentheses that wrap the whole expression. */
function unwrap(expr: string): string {
  let e = expr.replace(/\s+/g, ' ').trim();
  for (;;) {
    if (!e.startsWith('(')) return e;
    let closesAtEnd = true;
    scan(e, (i, depth) => {
      if (depth === 0 && i < e.length - 1) closesAtEnd = false;
    });
    if (!closesAtEnd) return e;
    e = e.slice(1, -1).trim();
  }
}

function splitTop(e: string, keyword: 'AND' | 'OR'): string[] {
  const token = ` ${keyword} `;
  const parts: string[] = [];
  let start = 0;
  scan(e, (i, depth) => {
    if (depth === 0 && e.startsWith(token, i)) {
      parts.push(e.slice(start, i));
      start = i + token.length;
      return start - 1;
    }
  });
  parts.push(e.slice(start));
  return parts.map((p) => p.trim());
}

/**
 * The terms an expression requires at its top level: its AND operands, unwrapped. An
 * expression whose top level is an OR is a single term, since no operand of it holds
 * on its own.
 */
function conjuncts(expr: string): string[] {
  const e = unwrap(expr);
  if (splitTop(e, 'OR').length > 1) return [e];
  const parts = splitTop(e, 'AND');
  return parts.length === 1 ? [e] : parts.flatMap(conjuncts);
}

const isCall = (fn: string) => (term: string | null) =>
  term !== null && new RegExp(`^(SELECT )?public\\.${fn}\\(\\)( AS ${fn})?$`).test(unwrap(term));
const isMfaCall = isCall('mfa_session_ok');
const isOwnerCall = isCall('is_owner');
const isNotViewAsClient = (expr: string | null) =>
  expr !== null && unwrap(expr).startsWith('NOT ') && isCall('is_view_as_client')(unwrap(expr).slice(4));
const ownerGated = (expr: string) => conjuncts(expr).some(isOwnerCall);
const CLIENT_REFERENCE = /\bpublic\.get_client_contact_id\(\)|\bauth\.uid\(\)/;
const bucketOf = (term: string) => /^bucket_id = '((?:[^']|'')*)'::text$/.exec(term)?.[1] ?? null;

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const API_ROLES = `ARRAY['anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid, 0::oid]`;
const grantee = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END`;

async function rows<T>(tx: Tx, sql: string): Promise<T[]> {
  return (await tx.query<T>(sql)).rows;
}

const CHECKS: Record<string, Check> = {
  /** 1. Every table in public has row-level security on. */
  async 'row-level security on every table'(tx) {
    const found = await rows<{ t: string }>(tx, `
      SELECT c.relname AS t FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      ORDER BY 1`);
    return found.map((r) => `${r.t}: row-level security is off`);
  },

  /**
   * 2. Every table in public, and storage.objects (every bucket's files), carries
   * <table>_mfa_gate: RESTRICTIVE, FOR ALL, TO authenticated, both clauses mfa_session_ok().
   */
  async 'the restrictive MFA gate on every table'(tx) {
    const found = await rows<{
      t: string; gate: string; name: string | null; permissive: boolean; cmd: string; roles: string[]; qual: string | null; chk: string | null;
    }>(tx, `
      SELECT CASE WHEN c.relnamespace = 'public'::regnamespace THEN c.relname ELSE c.oid::regclass::text END AS t,
             left(c.relname || '_mfa_gate', 63) AS gate,
             p.polname AS name, p.polpermissive AS permissive, p.polcmd AS cmd,
             ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END FROM unnest(p.polroles) r) AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = left(c.relname || '_mfa_gate', 63)
      WHERE (c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p'))
         OR c.oid = 'storage.objects'::regclass
      ORDER BY 1`);
    const out: string[] = [];
    for (const r of found) {
      const gate = `${r.t}: ${r.gate}`;
      if (!r.name) {
        out.push(`${r.t}: no ${r.gate} policy`);
        continue;
      }
      if (r.permissive) out.push(`${gate} is PERMISSIVE, not RESTRICTIVE`);
      if (r.cmd !== '*') out.push(`${gate} is not FOR ALL`);
      if (r.roles.join(',') !== 'authenticated') out.push(`${gate} applies to ${r.roles.join(', ')}, not authenticated`);
      if (!isMfaCall(r.qual)) out.push(`${gate} USING is ${r.qual ?? 'missing'}, not mfa_session_ok()`);
      if (!isMfaCall(r.chk)) out.push(`${gate} WITH CHECK is ${r.chk ?? 'missing'}, not mfa_session_ok()`);
    }
    return out;
  },

  /** 3. anon holds nothing in public (tables, columns, sequences, functions) beyond the allowlist. */
  async 'anon holds no privilege in public'(tx) {
    const found = await rows<{ obj: string; who: string; priv: string }>(tx, `
      SELECT c.relname || CASE WHEN c.relkind = 'S' THEN ' (sequence)' ELSE '' END AS obj, ${grantee} AS who, a.privilege_type AS priv
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND a.grantee = ANY (ARRAY['anon'::regrole::oid, 0::oid])
      UNION ALL
      SELECT c.relname || '.' || att.attname, ${grantee}, a.privilege_type
      FROM pg_class c
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = ANY (ARRAY['anon'::regrole::oid, 0::oid])
      UNION ALL
      SELECT p.oid::regprocedure::text, 'anon', 'EXECUTE'
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')
      ORDER BY 1, 3`);
    return found
      .filter((r) => !(r.priv === 'EXECUTE' && ANON_EXECUTE_ALLOWED.includes(r.obj)))
      .map((r) => `${r.obj}: ${r.who} holds ${r.priv}`);
  },

  /** 4. API roles (and PUBLIC) hold row access at most: no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. */
  async 'API roles hold row access only'(tx) {
    const found = await rows<{ obj: string; who: string; priv: string }>(tx, `
      SELECT c.relname AS obj, ${grantee} AS who, a.privilege_type AS priv
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.grantee = ANY (${API_ROLES}) AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      UNION ALL
      SELECT c.relname || '.' || att.attname, ${grantee}, a.privilege_type
      FROM pg_class c
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE c.relnamespace = 'public'::regnamespace
        AND a.grantee = ANY (${API_ROLES}) AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
      ORDER BY 1, 2, 3`);
    return found.map((r) => `${r.obj}: ${r.who} holds ${r.priv}`);
  },

  /** 5. Every SECURITY DEFINER function outside Supabase's own schemas pins search_path = ''. */
  async "SECURITY DEFINER pins search_path = ''"(tx) {
    const found = await rows<{ fn: string; cfg: string[] | null }>(tx, `
      SELECT p.oid::regprocedure::text AS fn, p.proconfig AS cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage')
        AND n.nspname !~ '^pg_'
      ORDER BY 1`);
    return found
      .filter((r) => !(r.cfg ?? []).some((c) => /^search_path=(""|)$/.test(c)))
      .map((r) => `${r.fn}: SECURITY DEFINER with ${(r.cfg ?? []).find((c) => c.startsWith('search_path=')) ?? 'no search_path'}`);
  },

  /** 6. Every FOR ALL policy, in any schema, states both USING and WITH CHECK. */
  async 'FOR ALL policies carry both clauses'(tx) {
    const found = await rows<{ t: string; name: string; no_using: boolean }>(tx, `
      SELECT n.nspname || '.' || c.relname AS t, p.polname AS name, p.polqual IS NULL AS no_using
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polcmd = '*' AND (p.polqual IS NULL OR p.polwithcheck IS NULL)
      ORDER BY 1, 2`);
    return found.map((r) => `${r.t}.${r.name}: FOR ALL without ${r.no_using ? 'USING' : 'WITH CHECK'}`);
  },

  /** 7. No function in public is executable by PUBLIC (a missing REVOKE leaves Postgres's default). */
  async 'no public function executable by PUBLIC'(tx) {
    const found = await rows<{ fn: string }>(tx, `
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY 1`);
    return found.map((r) => `${r.fn}: PUBLIC may execute it`);
  },

  /**
   * 8. A table a client session can write carries trg_impersonation_read_only. A write
   * policy (INSERT, UPDATE, DELETE, ALL; for authenticated or PUBLIC) makes its table
   * client-writable when it names get_client_contact_id() or auth.uid(), or when it
   * does not require is_owner() at its top level.
   */
  async 'View as client cannot write'(tx) {
    const found = await rows<{ t: string; name: string; cmd: string; qual: string | null; chk: string | null; guarded: boolean }>(tx, `
      SELECT c.relname AS t, p.polname AS name, p.polcmd AS cmd,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk,
             ${READ_ONLY_GUARDED('c.oid')} AS guarded
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'public'::regnamespace AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
        AND p.polroles && ARRAY['authenticated'::regrole::oid, 0::oid]
      ORDER BY 1, 2`);
    const out: string[] = [];
    const flagged = new Set<string>();
    for (const r of found) {
      const exprs = appliedClauses(r.cmd, r.qual, r.chk);
      if (!exprs.some((e) => CLIENT_REFERENCE.test(e) || !ownerGated(e))) continue;
      const key = `${r.t}.${r.name}`;
      flagged.add(key);
      if (key in IMPERSONATION_EXEMPT) {
        if (!exprs.every(ownerGated)) out.push(`${key}: allowlisted, but no longer requires is_owner()`);
      } else if (!r.guarded) {
        out.push(`${r.t}: client-writable through ${r.name}, without the trg_impersonation_read_only statement trigger`);
      }
    }
    for (const key of Object.keys(IMPERSONATION_EXEMPT)) {
      if (!flagged.has(key)) out.push(`${key}: allowlist entry matches no write policy; remove it`);
    }
    return out;
  },

  /**
   * 8b. Nor through a SECURITY DEFINER function, which runs past RLS: every table such a
   * function writes, when a signed-in session may call it, carries trg_impersonation_read_only,
   * unless the function is allowlisted and refuses everyone but the owner first.
   */
  async 'View as client cannot write through a definer'(tx) {
    const found = await rows<{ fn: string; src: string }>(tx, `
      SELECT p.oid::regprocedure::text AS fn, p.prosrc AS src FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND p.prorettype <> 'trigger'::regtype
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      ORDER BY 1`);
    const guarded = new Set((await rows<{ t: string }>(tx, `
      SELECT c.relname AS t FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND ${READ_ONLY_GUARDED('c.oid')}`)).map((r) => r.t));
    const out: string[] = [];
    const writers = new Set<string>();
    for (const r of found) {
      const writes = [...r.src.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(\w+)/gi)];
      if (writes.length === 0) continue;
      writers.add(r.fn);
      if (r.fn in DEFINER_WRITE_EXEMPT) {
        const refusal = r.src.search(/IF\s+NOT\s+public\.is_owner\(\)\s+THEN\s+RAISE/i);
        if (refusal < 0 || refusal > (writes[0].index ?? 0)) out.push(`${r.fn}: allowlisted, but does not refuse non-owners before it writes`);
        continue;
      }
      for (const t of new Set(writes.map((w) => w[1]))) {
        if (!guarded.has(t)) out.push(`${r.fn}: writes ${t}, which has no trg_impersonation_read_only statement trigger`);
      }
    }
    for (const fn of Object.keys(DEFINER_WRITE_EXEMPT)) {
      if (!writers.has(fn)) out.push(`${fn}: allowlist entry matches no definer that writes; remove it`);
    }
    return out;
  },

  /** 9. Every table published to supabase_realtime has row-level security on. */
  async 'realtime tables have row-level security'(tx) {
    const found = await rows<{ t: string }>(tx, `
      SELECT pt.schemaname || '.' || pt.tablename AS t
      FROM pg_publication_tables pt
      JOIN pg_namespace n ON n.nspname = pt.schemaname
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pt.tablename
      WHERE pt.pubname = 'supabase_realtime' AND NOT c.relrowsecurity
      ORDER BY 1`);
    return found.map((r) => `${r.t}: published to supabase_realtime with row-level security off`);
  },

  /**
   * 10. Every permissive storage.objects policy requires bucket_id = '<one bucket>' at
   * the top level of each of its clauses. (A restrictive policy only narrows, so it
   * cannot reach another bucket's objects.)
   */
  async 'storage policies name their bucket'(tx) {
    const found = await rows<{ name: string; cmd: string; qual: string | null; chk: string | null }>(tx, `
      SELECT p.polname AS name, p.polcmd AS cmd, pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_policy p
      WHERE p.polrelid = 'storage.objects'::regclass AND p.polpermissive
      ORDER BY 1`);
    const out: string[] = [];
    for (const r of found) {
      const buckets = new Set<string>();
      let unnamed = false;
      for (const e of appliedClauses(r.cmd, r.qual, r.chk)) {
        const named = conjuncts(e).map(bucketOf).filter((b): b is string => b !== null);
        if (named.length === 0) unnamed = true;
        named.forEach((b) => buckets.add(b));
      }
      if (unnamed) out.push(`storage.objects.${r.name}: a clause does not require bucket_id = '<bucket>' at its top level`);
      else if (buckets.size > 1) out.push(`storage.objects.${r.name}: names more than one bucket (${[...buckets].join(', ')})`);
    }
    return out;
  },

  /**
   * 11. View as client cannot write files either. storage.objects takes no trigger, so for
   * each of INSERT, UPDATE and DELETE it carries a RESTRICTIVE policy TO authenticated
   * whose clauses are NOT public.is_view_as_client(). Restrictive, so it holds for every
   * bucket whatever the bucket's own policies allow.
   */
  async 'View as client cannot write files'(tx) {
    const found = await rows<{ cmd: string; roles: string[]; qual: string | null; chk: string | null }>(tx, `
      SELECT p.polcmd AS cmd,
             ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END FROM unnest(p.polroles) r) AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_policy p
      WHERE p.polrelid = 'storage.objects'::regclass AND NOT p.polpermissive AND p.polcmd IN ('a', 'w', 'd')`);
    const refuses = (r: (typeof found)[number]) =>
      r.roles.join(',') === 'authenticated' &&
      (r.cmd === 'a' ? isNotViewAsClient(r.chk)
        : r.cmd === 'w' ? isNotViewAsClient(r.qual) && (r.chk === null || isNotViewAsClient(r.chk))
          : isNotViewAsClient(r.qual));
    return (['a', 'w', 'd'] as const)
      .filter((cmd) => !found.some((r) => r.cmd === cmd && refuses(r)))
      .map((cmd) => `storage.objects: no restrictive ${{ a: 'INSERT', w: 'UPDATE', d: 'DELETE' }[cmd]} policy TO authenticated refusing NOT public.is_view_as_client()`);
  },

  /**
   * 12. Views run with the caller's rights (security_invoker), so RLS applies through
   * them; a materialized view cannot, so no user session may read one.
   */
  async 'views keep row-level security'(tx) {
    const found = await rows<{ v: string; kind: string; invoker: boolean; readable: boolean }>(tx, `
      SELECT c.relname AS v, c.relkind::text AS kind,
             COALESCE((SELECT o.option_value::boolean FROM pg_options_to_table(c.reloptions) o
                       WHERE o.option_name = 'security_invoker'), false) AS invoker,
             has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT') AS readable
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
      ORDER BY 1`);
    return found
      .filter((r) => (r.kind === 'v' ? !r.invoker : r.readable))
      .map((r) => (r.kind === 'v'
        ? `${r.v}: view without security_invoker = true runs as its owner, past RLS`
        : `${r.v}: materialized view readable by a user session (RLS cannot apply to it)`));
  },
};

// ---------------------------------------------------------------------------

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
}, 60_000);

/** Runs `check` after `mutation` (if any), inside a transaction that is always rolled back. */
async function run(check: Check, mutation = ''): Promise<string[]> {
  let out: string[] = [];
  await db.transaction(async (tx) => {
    try {
      if (mutation) await tx.exec(mutation);
      await tx.exec(`SET LOCAL search_path = ''`);
      out = await check(tx);
    } finally {
      await tx.rollback();
    }
  });
  return out;
}

describe('the migrated schema', () => {
  it.each(Object.keys(CHECKS))('holds: %s', async (name) => {
    expect(await run(CHECKS[name])).toEqual([]);
  });
});

/** Replaces contacts' MFA gate with `definition` (everything after ON public.contacts). */
const regate = (definition: string) =>
  `DROP POLICY contacts_mfa_gate ON public.contacts; CREATE POLICY contacts_mfa_gate ON public.contacts ${definition};`;
const GATE = '((SELECT public.mfa_session_ok()))'; // the policy's own parentheses, then the subselect's

/** A new table that is client-writable through a policy built on `predicate`, RLS on and gated. */
const clientTable = (predicate: string, extra = '') => `
  CREATE TABLE public.mut_notes (id int PRIMARY KEY, contact_id uuid);
  ALTER TABLE public.mut_notes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY mut_notes_mfa_gate ON public.mut_notes AS RESTRICTIVE FOR ALL TO authenticated USING ${GATE} WITH CHECK ${GATE};
  CREATE POLICY mut_notes_insert ON public.mut_notes FOR INSERT TO authenticated WITH CHECK (${predicate});
  ${extra}`;
const READ_ONLY_TRIGGER = (on: string, shape = 'BEFORE INSERT OR UPDATE OR DELETE', each = 'STATEMENT', fn = 'public.enforce_impersonation_read_only()') =>
  `CREATE TRIGGER trg_impersonation_read_only ${shape} ON ${on} FOR EACH ${each} EXECUTE FUNCTION ${fn};`;

const MUTATIONS: Array<[check: string, what: string, sql: string, expected: RegExp]> = [
  ['row-level security on every table', 'a new table without RLS',
    'CREATE TABLE public.mut_open (id int);', /^mut_open: row-level security is off$/],
  ['row-level security on every table', 'RLS switched off on contacts',
    'ALTER TABLE public.contacts DISABLE ROW LEVEL SECURITY;', /^contacts: row-level security is off$/],

  ['the restrictive MFA gate on every table', 'a table with no gate',
    'CREATE TABLE public.mut_open (id int); ALTER TABLE public.mut_open ENABLE ROW LEVEL SECURITY;', /^mut_open: no mut_open_mfa_gate policy$/],
  ['the restrictive MFA gate on every table', 'a permissive gate',
    regate(`AS PERMISSIVE FOR ALL TO authenticated USING ${GATE} WITH CHECK ${GATE}`), /contacts_mfa_gate is PERMISSIVE/],
  ['the restrictive MFA gate on every table', 'a gate for SELECT only',
    regate(`AS RESTRICTIVE FOR SELECT TO authenticated USING ${GATE}`), /contacts_mfa_gate is not FOR ALL/],
  ['the restrictive MFA gate on every table', 'a gate without WITH CHECK',
    regate(`AS RESTRICTIVE FOR ALL TO authenticated USING ${GATE}`), /contacts_mfa_gate WITH CHECK is missing/],
  ['the restrictive MFA gate on every table', 'a gate that can be bypassed',
    regate(`AS RESTRICTIVE FOR ALL TO authenticated USING (${GATE} OR true) WITH CHECK ${GATE}`), /contacts_mfa_gate USING is .*, not mfa_session_ok\(\)/],
  ['the restrictive MFA gate on every table', 'a gate for the wrong role',
    regate(`AS RESTRICTIVE FOR ALL TO public USING ${GATE} WITH CHECK ${GATE}`), /contacts_mfa_gate applies to PUBLIC/],
  ['the restrictive MFA gate on every table', 'a gate under the wrong name',
    `ALTER POLICY contacts_mfa_gate ON public.contacts RENAME TO contacts_gate;`, /^contacts: no contacts_mfa_gate policy$/],
  ['the restrictive MFA gate on every table', 'the storage gate dropped',
    'DROP POLICY objects_mfa_gate ON storage.objects;', /^storage\.objects: no objects_mfa_gate policy$/],
  ['the restrictive MFA gate on every table', 'a permissive storage gate',
    `DROP POLICY objects_mfa_gate ON storage.objects; CREATE POLICY objects_mfa_gate ON storage.objects AS PERMISSIVE FOR ALL TO authenticated USING ${GATE} WITH CHECK ${GATE};`,
    /^storage\.objects: objects_mfa_gate is PERMISSIVE/],

  ['anon holds no privilege in public', 'a table grant to anon',
    'GRANT SELECT ON public.contacts TO anon;', /^contacts: anon holds SELECT$/],
  ['anon holds no privilege in public', 'a table grant to PUBLIC',
    'GRANT SELECT ON public.contacts TO PUBLIC;', /^contacts: PUBLIC holds SELECT$/],
  ['anon holds no privilege in public', 'a column grant to anon',
    'GRANT SELECT (email) ON public.contacts TO anon;', /^contacts\.email: anon holds SELECT$/],
  ['anon holds no privilege in public', 'a sequence grant to anon',
    'GRANT USAGE ON SEQUENCE public.mfa_backup_code_generation_seq TO anon;', /^mfa_backup_code_generation_seq \(sequence\): anon holds USAGE$/],
  ['anon holds no privilege in public', 'a function grant to anon',
    'GRANT EXECUTE ON FUNCTION public.is_owner() TO anon;', /^public\.is_owner\(\): anon holds EXECUTE$/],
  ['anon holds no privilege in public', 'a new function with no REVOKE',
    `CREATE FUNCTION public.mut_fn() RETURNS int LANGUAGE sql SET search_path = '' AS 'SELECT 1';`, /^public\.mut_fn\(\): anon holds EXECUTE$/],

  ['API roles hold row access only', 'TRUNCATE for the server',
    'GRANT TRUNCATE ON public.contacts TO service_role;', /^contacts: service_role holds TRUNCATE$/],
  ['API roles hold row access only', 'a column REFERENCES grant',
    'GRANT REFERENCES (id) ON public.contacts TO authenticated;', /^contacts\.id: authenticated holds REFERENCES$/],
  ['API roles hold row access only', 'TRIGGER for the server',
    'GRANT TRIGGER ON public.jobs TO service_role;', /^jobs: service_role holds TRIGGER$/],
  ['API roles hold row access only', 'MAINTAIN for a signed-in session',
    'GRANT MAINTAIN ON public.jobs TO authenticated;', /^jobs: authenticated holds MAINTAIN$/],
  ['API roles hold row access only', 'a new table with no REVOKE (Supabase grants ALL)',
    'CREATE TABLE public.mut_open (id int);', /^mut_open: anon holds TRUNCATE$/],

  ["SECURITY DEFINER pins search_path = ''", 'a definer with no search_path',
    `CREATE FUNCTION public.mut_def() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';`, /^public\.mut_def\(\): SECURITY DEFINER with no search_path$/],
  ["SECURITY DEFINER pins search_path = ''", 'a definer pinned to public',
    `CREATE FUNCTION public.mut_def() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT 1';`, /^public\.mut_def\(\): SECURITY DEFINER with search_path=public$/],
  ["SECURITY DEFINER pins search_path = ''", 'a definer in another schema',
    `CREATE SCHEMA mut_private; CREATE FUNCTION mut_private.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';`, /^mut_private\.f\(\): SECURITY DEFINER/],
  ["SECURITY DEFINER pins search_path = ''", 'search_path reset on an existing definer',
    'ALTER FUNCTION public.is_owner() RESET search_path;', /^public\.is_owner\(\): SECURITY DEFINER with no search_path$/],

  ['FOR ALL policies carry both clauses', 'FOR ALL with USING only',
    `CREATE POLICY mut_all ON public.contacts FOR ALL TO authenticated USING ((SELECT public.is_owner()));`, /^public\.contacts\.mut_all: FOR ALL without WITH CHECK$/],
  ['FOR ALL policies carry both clauses', 'FOR ALL with WITH CHECK only, on storage',
    `CREATE POLICY mut_all ON storage.objects FOR ALL TO authenticated WITH CHECK (bucket_id = 'b');`, /^storage\.objects\.mut_all: FOR ALL without USING$/],

  ['no public function executable by PUBLIC', 'EXECUTE granted to PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.is_owner() TO PUBLIC;', /^public\.is_owner\(\): PUBLIC may execute it$/],
  ['no public function executable by PUBLIC', 'a new function with no REVOKE',
    `CREATE FUNCTION public.mut_fn() RETURNS int LANGUAGE sql SET search_path = '' AS 'SELECT 1';`, /^public\.mut_fn\(\): PUBLIC may execute it$/],

  ['View as client cannot write', 'a client write policy with no trigger',
    clientTable('contact_id = (SELECT public.get_client_contact_id())'), /^mut_notes: client-writable through mut_notes_insert, without/],
  ['View as client cannot write', 'a write policy with no is_owner() gate (a helper hides the client check)',
    clientTable('(SELECT public.is_owner_or_server()) OR contact_id IS NOT NULL'), /^mut_notes: client-writable through mut_notes_insert, without/],
  ['View as client cannot write', 'the trigger, but per row',
    clientTable('contact_id = (SELECT public.get_client_contact_id())', READ_ONLY_TRIGGER('public.mut_notes', undefined, 'ROW')), /^mut_notes: client-writable/],
  ['View as client cannot write', 'the trigger, but not on UPDATE',
    clientTable('contact_id = (SELECT public.get_client_contact_id())', READ_ONLY_TRIGGER('public.mut_notes', 'BEFORE INSERT OR DELETE')), /^mut_notes: client-writable/],
  ['View as client cannot write', 'the trigger name on another function',
    clientTable('contact_id = (SELECT public.get_client_contact_id())', READ_ONLY_TRIGGER('public.mut_notes', undefined, undefined, 'public.set_updated_at()')), /^mut_notes: client-writable/],
  ['View as client cannot write', 'the trigger removed from client_tasks',
    'DROP TRIGGER trg_impersonation_read_only ON public.client_tasks;', /^client_tasks: client-writable through client_tasks_update/],
  ['View as client cannot write', 'the trigger disabled on client_activity_log',
    'ALTER TABLE public.client_activity_log DISABLE TRIGGER trg_impersonation_read_only;', /^client_activity_log: client-writable/],
  ['View as client cannot write', 'the allowlisted policy opened to clients',
    `ALTER POLICY audit_logs_owner_insert ON public.audit_logs WITH CHECK ((SELECT public.is_owner()) OR user_id = (SELECT auth.uid()));`,
    /^audit_logs\.audit_logs_owner_insert: allowlisted, but no longer requires is_owner\(\)$/],
  ['View as client cannot write', 'an allowlist entry whose policy is gone',
    'DROP POLICY audit_logs_owner_insert ON public.audit_logs;', /^audit_logs\.audit_logs_owner_insert: allowlist entry matches no write policy/],

  ['View as client cannot write', 'an insert policy with no WITH CHECK (Postgres reads it as true)',
    `CREATE TABLE public.mut_notes (id int); ALTER TABLE public.mut_notes ENABLE ROW LEVEL SECURITY;
     CREATE POLICY mut_notes_insert ON public.mut_notes FOR INSERT TO authenticated;`,
    /^mut_notes: client-writable through mut_notes_insert, without/],
  ['View as client cannot write', 'a delete policy with no USING',
    `CREATE TABLE public.mut_notes (id int); ALTER TABLE public.mut_notes ENABLE ROW LEVEL SECURITY;
     CREATE POLICY mut_notes_delete ON public.mut_notes FOR DELETE TO authenticated;`,
    /^mut_notes: client-writable through mut_notes_delete, without/],

  ['View as client cannot write through a definer', 'a client RPC that writes an owner-only table',
    `CREATE TABLE public.mut_notes (id int, contact_id uuid); ALTER TABLE public.mut_notes ENABLE ROW LEVEL SECURITY;
     CREATE FUNCTION public.mut_add_note() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
       AS 'INSERT INTO public.mut_notes (id, contact_id) VALUES (1, public.get_client_contact_id())';
     REVOKE ALL ON FUNCTION public.mut_add_note() FROM PUBLIC, anon;
     GRANT EXECUTE ON FUNCTION public.mut_add_note() TO authenticated;`,
    /^public\.mut_add_note\(\): writes mut_notes, which has no trg_impersonation_read_only/],
  ['View as client cannot write through a definer', 'the allowlisted definer loses its owner refusal',
    `CREATE OR REPLACE FUNCTION public.retry_job(p_job_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
       AS $$ BEGIN UPDATE public.jobs SET attempts = 0 WHERE id = p_job_id; END; $$;`,
    /^public\.retry_job\(uuid\): allowlisted, but does not refuse non-owners before it writes$/],
  ['View as client cannot write through a definer', 'an allowlist entry whose definer is gone',
    'DROP FUNCTION public.retry_job(uuid);', /^public\.retry_job\(uuid\): allowlist entry matches no definer/],

  ['realtime tables have row-level security', 'a published table without RLS',
    'CREATE TABLE public.mut_open (id int); ALTER PUBLICATION supabase_realtime ADD TABLE public.mut_open;', /^public\.mut_open: published to supabase_realtime/],

  ['storage policies name their bucket', 'a policy with no bucket',
    `CREATE POLICY mut_files ON storage.objects FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid())::text);`, /^storage\.objects\.mut_files: a clause does not require bucket_id/],
  ['storage policies name their bucket', 'a bucket test inside an OR',
    `CREATE POLICY mut_files ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'b' OR (SELECT public.is_owner()));`, /^storage\.objects\.mut_files: a clause does not require bucket_id/],
  ['storage policies name their bucket', 'an update that moves objects to another bucket',
    `CREATE POLICY mut_files ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'a') WITH CHECK (bucket_id = 'b');`, /^storage\.objects\.mut_files: names more than one bucket \(a, b\)$/],
  ['storage policies name their bucket', 'an insert whose WITH CHECK names no bucket',
    `CREATE POLICY mut_files ON storage.objects FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_owner()));`, /^storage\.objects\.mut_files: a clause does not require bucket_id/],
  ['storage policies name their bucket', 'an insert with no WITH CHECK at all (Postgres reads it as true)',
    `CREATE POLICY mut_files ON storage.objects FOR INSERT TO authenticated;`, /^storage\.objects\.mut_files: a clause does not require bucket_id/],

  ['View as client cannot write files', 'the upload refusal dropped',
    'DROP POLICY objects_view_as_client_insert ON storage.objects;', /^storage\.objects: no restrictive INSERT policy/],
  ['View as client cannot write files', 'an upload refusal with a way around it',
    'ALTER POLICY objects_view_as_client_insert ON storage.objects WITH CHECK (NOT (SELECT public.is_view_as_client()) OR true);',
    /^storage\.objects: no restrictive INSERT policy/],
  ['View as client cannot write files', 'the upload refusal made permissive',
    `DROP POLICY objects_view_as_client_insert ON storage.objects;
     CREATE POLICY objects_view_as_client_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (NOT (SELECT public.is_view_as_client()));`,
    /^storage\.objects: no restrictive INSERT policy/],
  ['View as client cannot write files', 'an update refusal whose WITH CHECK lets the row through',
    'ALTER POLICY objects_view_as_client_update ON storage.objects WITH CHECK (true);', /^storage\.objects: no restrictive UPDATE policy/],
  ['View as client cannot write files', 'the delete refusal reduced to true',
    'ALTER POLICY objects_view_as_client_delete ON storage.objects USING (true);', /^storage\.objects: no restrictive DELETE policy/],
  ['View as client cannot write files', 'the delete refusal moved to another role',
    'ALTER POLICY objects_view_as_client_delete ON storage.objects TO anon;', /^storage\.objects: no restrictive DELETE policy/],

  ['views keep row-level security', 'a view without security_invoker',
    'CREATE VIEW public.mut_view AS SELECT id FROM public.contacts;', /^mut_view: view without security_invoker/],
  ['views keep row-level security', 'a materialized view a user session can read',
    'CREATE MATERIALIZED VIEW public.mut_mview AS SELECT id FROM public.contacts; GRANT SELECT ON public.mut_mview TO authenticated;', /^mut_mview: materialized view readable/],
];

describe('each check catches its violation', () => {
  it.each(MUTATIONS)('%s: %s', async (check, _what, sql, expected) => {
    const found = await run(CHECKS[check], sql);
    expect(found.some((line) => expected.test(line)), found.join('\n') || '(nothing reported)').toBe(true);
  });

  it('every check has at least one mutation', () => {
    expect(Object.keys(CHECKS).filter((c) => !MUTATIONS.some(([m]) => m === c))).toEqual([]);
  });
});

/**
 * A domain table written by the rules: RLS, the gate, explicit privileges, a definer
 * RPC pinned and granted, the read-only trigger on a client-writable table, a realtime
 * publication, a private bucket with per-bucket policies, and an invoker view.
 */
const CONFORMING = `
  CREATE TABLE public.widget_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.widget_notes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY widget_notes_select ON public.widget_notes FOR SELECT TO authenticated
    USING ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
  CREATE POLICY widget_notes_insert ON public.widget_notes FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_owner()) OR contact_id = (SELECT public.get_client_contact_id()));
  CREATE POLICY widget_notes_owner_delete ON public.widget_notes FOR DELETE TO authenticated
    USING ((SELECT public.is_owner()));
  CREATE POLICY widget_notes_mfa_gate ON public.widget_notes AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT public.mfa_session_ok())) WITH CHECK ((SELECT public.mfa_session_ok()));
  CREATE TRIGGER trg_impersonation_read_only
    BEFORE INSERT OR UPDATE OR DELETE ON public.widget_notes
    FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_impersonation_read_only();
  REVOKE ALL ON public.widget_notes FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.widget_notes TO service_role;
  GRANT SELECT, INSERT, DELETE ON public.widget_notes TO authenticated;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.widget_notes;

  CREATE FUNCTION public.widget_note_count(p_contact_id uuid)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT count(*)::integer FROM public.widget_notes n
    WHERE n.contact_id = p_contact_id AND public.is_owner();
  $$;
  REVOKE ALL ON FUNCTION public.widget_note_count(uuid) FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.widget_note_count(uuid) TO authenticated;

  CREATE VIEW public.widget_note_counts WITH (security_invoker = true) AS
    SELECT contact_id, count(*) AS notes FROM public.widget_notes GROUP BY contact_id;
  REVOKE ALL ON public.widget_note_counts FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT ON public.widget_note_counts TO authenticated;

  INSERT INTO storage.buckets (id, name, public) VALUES ('widget-files', 'widget-files', false);
  CREATE POLICY widget_files_select ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'widget-files' AND (
      (SELECT public.is_owner())
      OR (storage.foldername(name))[1] = (SELECT public.get_client_contact_id())::text));
  CREATE POLICY widget_files_owner_all ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'widget-files' AND (SELECT public.is_owner()))
    WITH CHECK (bucket_id = 'widget-files' AND (SELECT public.is_owner()));
`;

describe('a table written by the rules', () => {
  it.each(Object.keys(CHECKS))('passes: %s', async (name) => {
    expect(await run(CHECKS[name], CONFORMING)).toEqual([]);
  });
});

/**
 * `supabase db push` applies `<version>_<name>.sql` files in version order and skips any
 * other name, which the harness would still load. Four-digit versions keep filename
 * order (the harness's) and version order (the CLI's) the same.
 */
function migrationNameProblems(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!m) {
      out.push(`${name}: not <4-digit version>_<lowercase name>.sql`);
      continue;
    }
    if (seen.has(m[1])) out.push(`${name}: version ${m[1]} is also ${seen.get(m[1])}`);
    seen.set(m[1], name);
  }
  return out;
}

describe('migration files', () => {
  const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations');

  it('are named for the Supabase CLI, one version each', () => {
    const names = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(names.length).toBeGreaterThanOrEqual(11);
    expect(migrationNameProblems(names)).toEqual([]);
  });

  it('a file of comments alone is valid for `supabase db push`', async () => {
    // The CLI runs each statement it splits from a file as a prepared statement (the
    // extended protocol). PGlite's query() takes that path too, which is why it refuses two
    // commands at once. A file with no statement reaches Postgres as one empty statement.
    await expect(db.query('SELECT 1; SELECT 2')).rejects.toThrow(/multiple commands/);
    for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(path.join(MIGRATIONS, name), 'utf8');
      if (sql.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--'))) continue;
      await expect(db.query(sql), name).resolves.toBeDefined();
    }
  });

  it('a duplicate version or a name the CLI would skip is reported', () => {
    expect(migrationNameProblems(['0003_documents.sql', '0003_more.sql', '20261010_x.sql', '0012_Bad-Name.sql'])).toEqual([
      '0003_more.sql: version 0003 is also 0003_documents.sql',
      '20261010_x.sql: not <4-digit version>_<lowercase name>.sql',
      '0012_Bad-Name.sql: not <4-digit version>_<lowercase name>.sql',
    ]);
  });
});

describe('conjuncts', () => {
  it('splits only the top level, and never inside quoted text', () => {
    expect(conjuncts(`(( SELECT public.is_owner() AS is_owner) AND (s <> 'it''s (x) AND y'::text))`))
      .toEqual(['SELECT public.is_owner() AS is_owner', `s <> 'it''s (x) AND y'::text`]);
    expect(conjuncts(`((bucket_id = 'a'::text) OR (x AND y))`)).toEqual([`(bucket_id = 'a'::text) OR (x AND y)`]);
    expect(conjuncts(`((a AND (b AND c)) AND d)`)).toEqual(['a', 'b', 'c', 'd']);
  });
});
