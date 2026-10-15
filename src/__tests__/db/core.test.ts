// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  anon, as, become, becomeSuperuser, count as countRows, createDb, errorOf, service, session, tryIn, user, type Principal,
} from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const CLIENT = '00000000-0000-4000-8000-000000000003';
const MFA_OWNER = '00000000-0000-4000-8000-000000000004';
const FILE_USER = '00000000-0000-4000-8000-000000000005';

const owner = user(OWNER);
const client = user(CLIENT, { appRole: 'admin' }); // a forged role claim grants nothing

const OWNER_ONLY_READ = ['audit_logs', 'auth_rate_limits', 'app_settings', 'jobs', 'dev_outbox', 'csp_violation_reports', 'org_profile'];
const SERVICE_ONLY = ['mfa_recovery_lockouts', 'mfa_backup_code_generations', 'mfa_backup_codes'];

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${CLIENT}', 'client@example.test'), ('${MFA_OWNER}', 'mfa@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id)
      VALUES ('Example Co', '${OWNER}', '${SYSTEM}');
    INSERT INTO public.audit_logs (user_id, action) VALUES ('${OWNER}', 'seed');
    INSERT INTO public.auth_rate_limits (action) VALUES ('seed');
    INSERT INTO public.app_settings (key, value) VALUES ('seed', '{}');
    INSERT INTO public.jobs (provider, action) VALUES ('seed', 'seed');
    INSERT INTO public.dev_outbox (channel, recipient) VALUES ('email', 'x@example.test');
    INSERT INTO public.csp_violation_reports (document_url, violated_directive) VALUES ('https://crm.example.com/', 'img-src');
  `);
}, 60_000);

const count = (who: Parameters<typeof as>[1], table: string) => countRows(db, who, table);

describe('principals', () => {
  it('is_owner is true only for the owner row, never for a role claim', async () => {
    expect((await as(db, owner, 'SELECT public.is_owner() AS v'))[0].v).toBe(true);
    expect((await as(db, client, 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
    expect((await as(db, user(SYSTEM), 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
  });

  it('an owner with a verified MFA factor is only the owner at aal2', async () => {
    await db.exec(`
      UPDATE public.org_profile SET owner_user_id = '${MFA_OWNER}';
      INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${MFA_OWNER}', 'verified');`);
    try {
      expect((await as(db, user(MFA_OWNER), 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
      expect((await as(db, user(MFA_OWNER, { aal: 'aal2' }), 'SELECT public.is_owner() AS v'))[0].v).toBe(true);
    } finally {
      await db.exec(`
        DELETE FROM auth.mfa_factors WHERE user_id = '${MFA_OWNER}';
        UPDATE public.org_profile SET owner_user_id = '${OWNER}';`);
    }
  });

  it('a token issued before an MFA recovery lockout is no longer the owner', async () => {
    await db.exec(`INSERT INTO public.mfa_recovery_lockouts VALUES ('${OWNER}', now())`);
    try {
      const stale = user(OWNER, { iat: Math.floor(Date.now() / 1000) - 3600 });
      const fresh = user(OWNER, { iat: Math.floor(Date.now() / 1000) + 5 });
      expect((await as(db, stale, 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
      expect((await as(db, fresh, 'SELECT public.is_owner() AS v'))[0].v).toBe(true);
      const noIat = { role: 'authenticated' as const, claims: { sub: OWNER, role: 'authenticated', aal: 'aal2' } };
      expect((await as(db, noIat, 'SELECT public.is_owner() AS v'))[0].v).toBe(false);
      const guard = await as(db, service, `SELECT public.mfa_guard_denied('${OWNER}', 'aal2', NULL) AS v`);
      expect(guard[0].v).toBe(true);
    } finally {
      await db.exec(`DELETE FROM public.mfa_recovery_lockouts WHERE user_id = '${OWNER}'`);
    }
  });

  it('audit_actor falls back to the system actor when no user is signed in', async () => {
    expect((await as(db, service, 'SELECT public.audit_actor() AS v'))[0].v).toBe(SYSTEM);
    expect((await as(db, owner, 'SELECT public.audit_actor() AS v'))[0].v).toBe(OWNER);
  });
});

describe('table access', () => {
  it.each(OWNER_ONLY_READ)('%s: the owner reads it; anon and a client do not', async (table) => {
    expect(await count(owner, table)).toBeGreaterThan(0);
    expect(await count(client, table)).toBe(0);
    expect(await errorOf(db, anon, `SELECT 1 FROM public.${table}`)).toMatch(/permission denied/);
  });

  it.each(SERVICE_ONLY)('%s: no user session can read it, not even the owner', async (table) => {
    expect(await errorOf(db, owner, `SELECT 1 FROM public.${table}`)).toMatch(/permission denied/);
    expect(await errorOf(db, anon, `SELECT 1 FROM public.${table}`)).toMatch(/permission denied/);
  });

  it('a client cannot write any core table', async () => {
    expect(await errorOf(db, client, `INSERT INTO public.app_settings (key, value) VALUES ('x', '{}')`)).toMatch(/row-level security/);
    expect(await errorOf(db, client, `INSERT INTO public.audit_logs (user_id, action) VALUES ('${CLIENT}', 'x')`)).toMatch(/row-level security/);
    expect(await errorOf(db, client, `INSERT INTO public.jobs (provider, action) VALUES ('x', 'x')`)).toMatch(/permission denied/);
    const updated = await as(db, client, `UPDATE public.org_profile SET display_name = 'Hijacked' RETURNING 1`);
    expect(updated).toHaveLength(0);
  });

  it('the owner can write an audit row only as themself', async () => {
    expect(await errorOf(db, owner, `INSERT INTO public.audit_logs (user_id, action) VALUES ('${OWNER}', 'x')`)).toBeNull();
    expect(await errorOf(db, owner, `INSERT INTO public.audit_logs (user_id, action) VALUES ('${CLIENT}', 'x')`)).toMatch(/row-level security/);
  });

  it('the owner edits identity fields but cannot reassign the owner or system actor', async () => {
    expect(await errorOf(db, owner, `UPDATE public.org_profile SET display_name = 'Renamed'`)).toBeNull();
    expect(await errorOf(db, owner, `UPDATE public.org_profile SET owner_user_id = '${CLIENT}'`)).toMatch(/not editable/);
    expect(await errorOf(db, service, `UPDATE public.org_profile SET system_user_id = '${CLIENT}'`)).toBeNull();
  });

  it('org_profile holds exactly one row', async () => {
    expect(await errorOf(db, service, `INSERT INTO public.org_profile (display_name) VALUES ('Second')`)).toMatch(/duplicate key|check constraint/);
  });

  it('get_org_branding exposes display fields to anon, never user ids', async () => {
    const [{ v }] = await as<{ v: Record<string, unknown> }>(db, anon, 'SELECT public.get_org_branding() AS v');
    expect(v.display_name).toBe('Example Co');
    expect(JSON.stringify(v)).not.toContain(OWNER);
    expect(JSON.stringify(v)).not.toContain(SYSTEM);
  });
});

describe('audit log is append-only', () => {
  it('refuses UPDATE and DELETE even for the service role', async () => {
    expect(await errorOf(db, service, `UPDATE public.audit_logs SET action = 'x'`)).toMatch(/append-only/);
    expect(await errorOf(db, service, `DELETE FROM public.audit_logs`)).toMatch(/append-only/);
  });

  it('refuses TRUNCATE: the service role lacks the privilege, and the owner role hits the trigger', async () => {
    expect(await errorOf(db, service, `TRUNCATE public.audit_logs`)).toMatch(/permission denied/);
    await expect(db.exec(`TRUNCATE public.audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe('files: the MFA gate holds in every bucket', () => {
  // A bucket whose own policy asks nothing about MFA, so only objects_mfa_gate stands
  // between an enrolled user at aal1 and their file. Rolled back with the session.
  const filesSeenBy = (who: Principal) =>
    session(db, service, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${FILE_USER}', 'files@example.test');
        INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${FILE_USER}', 'verified');
        INSERT INTO storage.buckets (id, name) VALUES ('own-files', 'own-files');
        CREATE POLICY own_files_select ON storage.objects FOR SELECT TO authenticated
          USING (bucket_id = 'own-files' AND owner_id = (SELECT auth.uid())::text);
        INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('own-files', 'a.pdf', '${FILE_USER}');`);
      await become(tx, who);
      return (await tx.query('SELECT name FROM storage.objects')).rows.length;
    });

  it('an enrolled user at aal1 sees none of its files; at aal2 it sees them', async () => {
    expect(await filesSeenBy(user(FILE_USER))).toBe(0);
    expect(await filesSeenBy(user(FILE_USER, { aal: 'aal2' }))).toBe(1);
  });
});

describe('MFA recovery lockout', () => {
  it('never moves the cutoff backwards', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`INSERT INTO public.mfa_recovery_lockouts VALUES ('${CLIENT}', now() + interval '1 day')`);
      const before = (await tx.query<{ t: string }>(`SELECT revoked_before::text AS t FROM public.mfa_recovery_lockouts WHERE user_id = '${CLIENT}'`)).rows[0].t;
      await tx.query(`SELECT public.mfa_recovery_lockout_stamp('${CLIENT}')`);
      const after = (await tx.query<{ t: string }>(`SELECT revoked_before::text AS t FROM public.mfa_recovery_lockouts WHERE user_id = '${CLIENT}'`)).rows[0].t;
      return { before, after };
    });
    expect(out.after).toBe(out.before);
  });
});

describe('function privileges', () => {
  const SERVICE_ONLY_FNS = [
    `public.check_auth_ip_rate_limit('a', '1.2.3.4', 1, 1)`,
    `public.check_auth_global_rate_limit('a', 1, 1)`,
    `public.check_auth_user_rate_limit('a', '${CLIENT}', 1, 1)`,
    `public.check_public_rate_limit('a', '1.2.3.4', 1, 1, 1, 1)`,
    `public.claim_next_jobs(1, 60)`,
    `public.mfa_backup_code_claim('${CLIENT}', 'h')`,
    `public.mfa_guard_denied('${CLIENT}', 'aal1', 0)`,
    `public.complete_job('${CLIENT}', '${CLIENT}')`,
    `public.fail_job('${CLIENT}', '${CLIENT}', 'x')`,
    `public.cleanup_core_operational_rows()`,
    `public.cleanup_aged_audit_logs()`,
  ];

  it.each(SERVICE_ONLY_FNS)('%s is not callable by anon, a client or the owner', async (call) => {
    expect(await errorOf(db, anon, `SELECT ${call}`)).toMatch(/permission denied/);
    expect(await errorOf(db, client, `SELECT ${call}`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `SELECT ${call}`)).toMatch(/permission denied/);
  });

  it('the queue and retention functions are the server\'s alone', async () => {
    const fns = ['claim_next_jobs(integer,integer)', 'complete_job(uuid,uuid,jsonb)', 'fail_job(uuid,uuid,text)',
      'cleanup_core_operational_rows()', 'cleanup_aged_audit_logs()'];
    for (const fn of fns) {
      const [row] = (await db.query<{ anon: boolean; signed_in: boolean; server: boolean }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS signed_in,
                has_function_privilege('service_role', $1, 'EXECUTE') AS server`, [`public.${fn}`])).rows;
      expect([fn, row]).toEqual([fn, { anon: false, signed_in: false, server: true }]);
    }
  });

  it('owner-only functions refuse a client', async () => {
    expect(await errorOf(db, client, 'SELECT public.get_job_status_counts()')).toMatch(/owner required/);
    expect(await errorOf(db, owner, 'SELECT public.get_job_status_counts()')).toBeNull();
  });
});

describe('csp_violation_reports: a row is a report', () => {
  it.each([
    ['all null', `INSERT INTO public.csp_violation_reports (disposition) VALUES ('enforce')`],
    ['no directive', `INSERT INTO public.csp_violation_reports (document_url) VALUES ('https://crm.example.com/')`],
    ['no URL', `INSERT INTO public.csp_violation_reports (violated_directive) VALUES ('img-src')`],
    ['empty strings', `INSERT INTO public.csp_violation_reports (document_url, violated_directive) VALUES ('', '')`],
    ['an empty URL', `INSERT INTO public.csp_violation_reports (document_url, violated_directive) VALUES ('', 'img-src')`],
    ['an empty directive', `INSERT INTO public.csp_violation_reports (blocked_url, effective_directive) VALUES ('https://cdn.example.net/x.js', '')`],
  ])('refuses a row with %s', async (_what, sql) => {
    expect(await errorOf(db, service, sql)).toMatch(/csp_violation_reports_well_formed/);
  });

  it('takes a row with a blocked URL and an effective directive', async () => {
    expect(await errorOf(db, service,
      `INSERT INTO public.csp_violation_reports (blocked_url, effective_directive) VALUES ('https://cdn.example.net/x.js', 'script-src')`)).toBeNull();
  });
});

describe('rate limits', () => {
  it('counts up to the limit, then returns null', async () => {
    const rows = await as<{ a: number; b: number; c: number | null }>(db, service, `
      SELECT public.check_auth_ip_rate_limit('t', '9.9.9.9', 2, 5) AS a,
             public.check_auth_ip_rate_limit('t', '9.9.9.9', 2, 5) AS b,
             public.check_auth_ip_rate_limit('t', '9.9.9.9', 2, 5) AS c`);
    expect(rows[0]).toEqual({ a: 1, b: 2, c: null });
  });

  it('buckets a missing or unparseable IP together instead of exempting it', async () => {
    const rows = await as<{ a: number; b: number | null }>(db, service, `
      SELECT public.check_auth_ip_rate_limit('u', NULL, 1, 5) AS a,
             public.check_auth_ip_rate_limit('u', 'not-an-ip', 1, 5) AS b`);
    expect(rows[0]).toEqual({ a: 1, b: null });
  });

  it.each([
    `public.check_auth_ip_rate_limit('x', '1.1.1.1', NULL, 5)`,
    `public.check_auth_ip_rate_limit('x', '1.1.1.1', 5, -1)`,
    `public.check_auth_global_rate_limit('x', 5, NULL)`,
    `public.check_auth_user_rate_limit('x', '${CLIENT}', 0, 5)`,
    `public.check_public_rate_limit('x', '1.1.1.1', 0, 5, 5, 5)`,
    `public.check_public_rate_limit('x', '1.1.1.1', 5, 5, 5, NULL)`,
  ])('%s raises instead of allowing everything', async (call) => {
    expect(await errorOf(db, service, `SELECT ${call}`)).toMatch(/positive max count and window/);
  });

  describe('check_public_rate_limit: both buckets in one call', () => {
    /** The three calls' answers, then the rows each bucket holds, in one rolled-back session. */
    const run = (action: string, calls: string[]) => session(db, service, async (tx) => {
      const answers = (await tx.query<Record<string, number | null>>(`SELECT ${calls.map((c, i) => `${c} AS c${i}`).join(', ')}`)).rows[0];
      const rows = (await tx.query<{ ip: number; global: number }>(`
        SELECT count(*) FILTER (WHERE action = '${action}.ip')::int AS ip,
               count(*) FILTER (WHERE action = '${action}.global')::int AS global
        FROM public.auth_rate_limits`)).rows[0];
      return { answers: Object.values(answers), rows };
    });

    it('once the shared ceiling is spent, a fresh address is refused and records nothing', async () => {
      expect(await run('pg', [
        `public.check_public_rate_limit('pg', '10.0.0.1', 5, 5, 2, 60)`,
        `public.check_public_rate_limit('pg', '10.0.0.2', 5, 5, 2, 60)`,
        `public.check_public_rate_limit('pg', '10.0.0.3', 5, 5, 2, 60)`,
      ])).toEqual({ answers: [1, 2, null], rows: { ip: 2, global: 2 } });
    });

    it('an address over its own limit is refused first and spends nothing of the shared ceiling', async () => {
      expect(await run('pi', [
        `public.check_public_rate_limit('pi', '10.0.0.9', 1, 5, 50, 60)`,
        `public.check_public_rate_limit('pi', '10.0.0.9', 1, 5, 50, 60)`,
        `public.check_public_rate_limit('pi', NULL, 1, 5, 50, 60)`,
      ])).toEqual({ answers: [1, null, 2], rows: { ip: 2, global: 2 } });
    });

    it('shares its buckets with the two single functions', async () => {
      const rows = await as<{ g: number }>(db, service, `
        SELECT public.check_auth_global_rate_limit('ps.global', 5, 5),
               public.check_public_rate_limit('ps', '10.0.0.5', 5, 5, 5, 5) AS g`);
      expect(rows[0].g).toBe(2);
    });
  });

  it('refuses a null user id', async () => {
    const rows = await as<{ v: number | null }>(db, service, `SELECT public.check_auth_user_rate_limit('v', NULL, 5, 5) AS v`);
    expect(rows[0].v).toBeNull();
  });

  it('keeps per-user rows out of the global bucket of the same action', async () => {
    const rows = await as<{ g: number }>(db, service, `
      SELECT public.check_auth_user_rate_limit('w', '${CLIENT}', 5, 5),
             public.check_auth_global_rate_limit('w', 5, 5) AS g`);
    expect(rows[0].g).toBe(1);
  });
});

describe('jobs', () => {
  const claim = `SELECT v->>'id' AS id, v->>'claim_token' AS token FROM public.claim_next_jobs(10, 60) v`;

  it('claims a due job once, then backs off a failure', async () => {
    const out = await session(db, service, async (tx) => {
      const first = (await tx.query<{ id: string; token: string }>(claim)).rows;
      const second = (await tx.query(claim)).rows;
      const fail = (await tx.query<{ v: { status: string; backoff_sec: number } }>(
        `SELECT public.fail_job($1, $2, 'boom') AS v`, [first[0].id, first[0].token])).rows[0].v;
      return { first, second, fail };
    });
    expect(out.first).toHaveLength(1);
    expect(out.second).toHaveLength(0);
    expect(out.fail.status).toBe('pending');
    expect(out.fail.backoff_sec).toBe(120);
  });

  it('a worker whose lease was reclaimed cannot report an outcome', async () => {
    const out = await session(db, service, async (tx) => {
      const a = (await tx.query<{ id: string; token: string }>(claim)).rows[0];
      await tx.exec(`UPDATE public.jobs SET claimed_until = now() - interval '1 second'`);
      const b = (await tx.query<{ id: string; token: string }>(claim)).rows[0];
      const staleComplete = (await tx.query<{ v: boolean }>(
        `SELECT public.complete_job($1, $2) AS v`, [a.id, a.token])).rows[0].v;
      const staleFail = (await tx.query<{ v: { ok: boolean } }>(
        `SELECT public.fail_job($1, $2, 'late') AS v`, [a.id, a.token])).rows[0].v;
      const liveComplete = (await tx.query<{ v: boolean }>(
        `SELECT public.complete_job($1, $2) AS v`, [b.id, b.token])).rows[0].v;
      return { sameJob: a.id === b.id, newToken: a.token !== b.token, staleComplete, staleFail, liveComplete };
    });
    expect(out).toEqual({ sameJob: true, newToken: true, staleComplete: false, staleFail: { ok: false, reason: 'claim_not_live' }, liveComplete: true });
  });

  it('a lease that expires on the final attempt dies instead of being reclaimed', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.jobs SET max_attempts = 1`);
      await tx.query(claim);
      await tx.exec(`UPDATE public.jobs SET claimed_until = now() - interval '1 second'`);
      const again = (await tx.query(claim)).rows;
      const status = (await tx.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM public.jobs`)).rows[0];
      return { again, status };
    });
    expect(out.again).toHaveLength(0);
    expect(out.status).toEqual({ status: 'dead', attempts: 1 });
  });
});

describe('jobs: the final lease', () => {
  const claim = `SELECT v->>'id' AS id FROM public.claim_next_jobs(10, 60) v`;

  const deadAfterLease = (previous: string | null) =>
    session(db, service, async (tx) => {
      await tx.exec(`UPDATE public.jobs SET max_attempts = 1`);
      await tx.query(claim);
      await tx.query(`UPDATE public.jobs SET claimed_until = now() - interval '1 second', last_error = $1`, [previous]);
      await tx.query(claim);
      return (await tx.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM public.jobs`)).rows[0];
    });

  it("says the lease expired, and keeps the earlier attempt's error beside it", async () => {
    expect(await deadAfterLease('boom')).toEqual({
      status: 'dead',
      last_error: 'lease expired on the final attempt (previous attempt: boom)',
    });
  });

  it('with no earlier error, says only that the lease expired', async () => {
    expect(await deadAfterLease(null)).toEqual({ status: 'dead', last_error: 'lease expired on the final attempt' });
  });

  it('never grows past 1000 characters', async () => {
    const row = await deadAfterLease('e'.repeat(2000));
    expect(row.last_error).toHaveLength(1000);
    expect(row.last_error.startsWith('lease expired on the final attempt (previous attempt: eee')).toBe(true);
  });
});

describe('retention: cleanup_core_operational_rows', () => {
  const ago = (days: number) => `now() - interval '${days} days'`;

  it('removes exactly the aged rows and reports how many', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`
        INSERT INTO public.jobs (provider, action, status, finished_at, created_at, scheduled_at) VALUES
          ('ret', 'success_31', 'success', ${ago(31)}, ${ago(31)}, ${ago(31)}),
          ('ret', 'success_29', 'success', ${ago(29)}, ${ago(29)}, ${ago(29)}),
          ('ret', 'dead_91', 'dead', ${ago(91)}, ${ago(91)}, ${ago(91)}),
          ('ret', 'dead_89', 'dead', ${ago(89)}, ${ago(89)}, ${ago(89)}),
          ('ret', 'failed_400', 'failed', ${ago(400)}, ${ago(400)}, ${ago(400)}),
          ('ret', 'pending_400', 'pending', NULL, ${ago(400)}, ${ago(400)}),
          ('ret', 'running_400', 'running', NULL, ${ago(400)}, ${ago(400)});
        INSERT INTO public.auth_rate_limits (action, created_at) VALUES ('ret_8', ${ago(8)}), ('ret_6', ${ago(6)});
        INSERT INTO public.csp_violation_reports (document_url, violated_directive, disposition, received_at) VALUES
          ('https://crm.example.com/', 'img-src', 'd31', ${ago(31)}), ('https://crm.example.com/', 'img-src', 'd29', ${ago(29)});
        INSERT INTO public.dev_outbox (channel, recipient, created_at) VALUES
          ('email', 'eight@example.test', ${ago(8)}), ('sms', 'six@example.test', ${ago(6)});`);
      const result = (await tx.query<{ v: Record<string, number> }>('SELECT public.cleanup_core_operational_rows() AS v')).rows[0].v;
      const left = async (sql: string) => (await tx.query<{ k: string }>(sql)).rows.map((r) => r.k).sort();
      return {
        result,
        jobs: await left(`SELECT action AS k FROM public.jobs WHERE provider = 'ret'`),
        limits: await left(`SELECT action AS k FROM public.auth_rate_limits WHERE action LIKE 'ret_%'`),
        csp: await left(`SELECT disposition AS k FROM public.csp_violation_reports WHERE disposition LIKE 'd%'`),
        outbox: await left(`SELECT recipient AS k FROM public.dev_outbox WHERE recipient IN ('eight@example.test', 'six@example.test')`),
        seedsKept: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.jobs WHERE provider = 'seed'`)).rows[0].n,
      };
    });
    expect(out.result).toEqual({ jobs_success: 1, jobs_dead: 1, rate_limits: 1, csp_reports: 1, dev_outbox: 1 });
    expect(out.jobs).toEqual(['dead_89', 'failed_400', 'pending_400', 'running_400', 'success_29']);
    expect(out.limits).toEqual(['ret_6']);
    expect(out.csp).toEqual(['d29']);
    expect(out.outbox).toEqual(['six@example.test']);
    expect(out.seedsKept).toBe(1);
  });
});

describe('retention: cleanup_aged_audit_logs', () => {
  it('removes rows older than three years, keeps younger ones, and leaves the log append-only after', async () => {
    const out = await session(db, service, async (tx) => {
      await tx.exec(`
        INSERT INTO public.audit_logs (user_id, action, created_at) VALUES
          ('${OWNER}', 'ret_old', now() - interval '3 years' - interval '1 day'),
          ('${OWNER}', 'ret_young', now() - interval '3 years' + interval '1 day');`);
      const result = (await tx.query<{ v: Record<string, number> }>('SELECT public.cleanup_aged_audit_logs() AS v')).rows[0].v;
      const left = (await tx.query<{ action: string }>(`SELECT action FROM public.audit_logs WHERE action LIKE 'ret_%'`)).rows;
      const escape = (await tx.query<{ v: string | null }>(`SELECT current_setting('app.allow_audit_maintenance', true) AS v`)).rows[0].v;
      const deleteAfter = await tryIn(tx, `DELETE FROM public.audit_logs WHERE action = 'ret_young'`);
      return { result, left: left.map((r) => r.action), escape, deleteAfter };
    });
    expect(out.result).toEqual({ audit_logs: 1 });
    expect(out.left).toEqual(['ret_young']);
    expect(out.escape).not.toBe('on');
    expect(out.deleteAfter).toMatch(/append-only/);
  });
});

describe('audit log shape', () => {
  const insert = (action: string, details = '{}') =>
    errorOf(db, owner, `INSERT INTO public.audit_logs (user_id, action, details) VALUES ('${OWNER}', $1, $2)`, [action, details]);

  it('takes a lowercase action with ids and codes', async () => {
    expect(await insert('mfa_enabled', '{"factor_id": "x"}')).toBeNull();
    expect(await insert('contact.updated')).toBeNull();
  });

  it.each(['2fa_enabled', 'MFA Enabled', 'owner login', '', 'a'.repeat(101)])('refuses the action %j', async (action) => {
    expect(await insert(action)).toMatch(/check constraint/);
  });

  it('refuses details that are not an object, or over 8 KB', async () => {
    expect(await insert('x', '[]')).toMatch(/check constraint/);
    expect(await insert('x', JSON.stringify({ blob: 'z'.repeat(9000) }))).toMatch(/check constraint/);
  });
});

describe('dev outbox: the owner clears it', () => {
  // A blind DELETE (no WHERE, no RETURNING) reads no column, so only the DELETE policy
  // stands between the caller and the rows; the count is taken back as the server.
  const deleted = (who: Principal) =>
    session(db, service, async (tx) => {
      await tx.exec(`INSERT INTO public.dev_outbox (channel, recipient) VALUES ('sms', 'clear@example.test')`);
      const before = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.dev_outbox')).rows[0].n;
      await become(tx, who);
      await tx.exec('DELETE FROM public.dev_outbox');
      await become(tx, service);
      return before - (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.dev_outbox')).rows[0].n;
    });

  it('the owner deletes every row', async () => {
    expect(await deleted(owner)).toBe(2);
  });

  it('a client deletes nothing, and anon is refused', async () => {
    expect(await deleted(client)).toBe(0);
    expect(await errorOf(db, anon, 'DELETE FROM public.dev_outbox')).toMatch(/permission denied/);
  });

  it('an owner enrolled in MFA deletes nothing below aal2', async () => {
    const enrolled = await session(db, service, async (tx) => {
      await becomeSuperuser(tx);
      await tx.exec(`
        UPDATE public.org_profile SET owner_user_id = '${MFA_OWNER}';
        INSERT INTO auth.mfa_factors (user_id, status) VALUES ('${MFA_OWNER}', 'verified');`);
      await become(tx, user(MFA_OWNER));
      await tx.exec('DELETE FROM public.dev_outbox');
      await become(tx, service);
      return (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM public.dev_outbox')).rows[0].n;
    });
    expect(enrolled).toBe(1);
  });

  it('nobody but the server writes it', async () => {
    expect(await errorOf(db, owner, `INSERT INTO public.dev_outbox (channel, recipient) VALUES ('email', 'a@example.test')`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `UPDATE public.dev_outbox SET subject = 'x'`)).toMatch(/permission denied/);
  });
});
