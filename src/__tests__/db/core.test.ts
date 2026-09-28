// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, as, createDb, errorOf, service, session, user } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const CLIENT = '00000000-0000-4000-8000-000000000003';
const MFA_OWNER = '00000000-0000-4000-8000-000000000004';

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
    INSERT INTO public.csp_violation_reports (raw) VALUES ('{}');
  `);
}, 60_000);

const count = async (who: Parameters<typeof as>[1], table: string) => {
  const rows = await as<{ n: number }>(db, who, `SELECT count(*)::int AS n FROM public.${table}`);
  return rows[0].n;
};

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
    `public.claim_next_jobs(1, 60)`,
    `public.mfa_backup_code_claim('${CLIENT}', 'h')`,
    `public.mfa_guard_denied('${CLIENT}', 'aal1', 0)`,
  ];

  it.each(SERVICE_ONLY_FNS)('%s is not callable by anon or a signed-in user', async (call) => {
    expect(await errorOf(db, anon, `SELECT ${call}`)).toMatch(/permission denied/);
    expect(await errorOf(db, owner, `SELECT ${call}`)).toMatch(/permission denied/);
  });

  it('owner-only functions refuse a client', async () => {
    expect(await errorOf(db, client, 'SELECT public.get_job_status_counts()')).toMatch(/owner required/);
    expect(await errorOf(db, owner, 'SELECT public.get_job_status_counts()')).toBeNull();
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
  ])('%s raises instead of allowing everything', async (call) => {
    expect(await errorOf(db, service, `SELECT ${call}`)).toMatch(/positive max count and window/);
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
