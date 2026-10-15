// @vitest-environment node
// 0007_mcp on the real migrations: who may touch the OAuth tables and call the connector's
// functions, and what each function does. Every call runs as the role that makes it in
// production (service_role for the edge functions, a signed-in session for the owner's two)
// inside a transaction that is rolled back, so each test starts from the same fixtures.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asAnon,
  asClient,
  asOwner,
  asServer,
  become,
  becomeSuperuser,
  createDb,
  expectDenied,
  OWNER_ID,
  seedContact,
  seedCore,
  seedPortalAccount,
  session,
  SYSTEM_ID,
  user,
  type Principal,
} from './harness';

type Tx = Parameters<Parameters<typeof session>[2]>[0];

const TABLES = ['mcp_oauth_clients', 'mcp_oauth_requests', 'mcp_oauth_grants', 'mcp_oauth_tokens'] as const;
const CLIENT_ID = 'mcpc_' + 'a'.repeat(43);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const IMPERSONATED_SESSION = randomUUID();

let db: PGlite;
let contactA: string;
let contactB: string;
let clientAUser: string;
let clientBUser: string;
let clientA: Principal;
let clientB: Principal;
let viewAsClient: Principal;

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactA = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', business_name: 'Acme LLC' });
  contactB = await seedContact(db, { first_name: 'Bo', last_name: 'Baker', email: 'bo@example.com' });
  clientAUser = (await seedPortalAccount(db, contactA)).userId;
  clientBUser = (await seedPortalAccount(db, contactB)).userId;
  clientA = asClient(clientAUser);
  clientB = asClient(clientBUser);
  viewAsClient = asClient(clientAUser, { sessionId: IMPERSONATED_SESSION });
  // The owner's View-as-client session for client A, bound to the minted session.
  await db.query(
    `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
     VALUES ($1, $2, $3, 'ada@example.com', $4)`,
    [OWNER_ID, contactA, clientAUser, IMPERSONATED_SESSION],
  );
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call public.<fn> with named arguments; resolves to its single result. */
async function call<T = unknown>(tx: Tx, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args);
  const sql = `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`;
  const params = keys.map((k) => {
    const v = args[k];
    return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  return (await tx.query<{ r: T }>(sql, params)).rows[0].r;
}

/** Run `fn` as the server, rolled back afterwards. */
const asServerTx = <T>(fn: (tx: Tx) => Promise<T>) => session(db, asServer, fn);

const audit = { p_actor: OWNER_ID, p_ip: '203.0.113.7', p_user_agent: 'test-agent' };
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A registered client, a live grant approved by `approvedBy`, and its access and refresh tokens. */
async function seedGrant(
  tx: Tx,
  opts: { approvedBy?: string; access?: string; refresh?: string; revoked?: boolean; expired?: boolean; lastUsedAgo?: string } = {},
): Promise<string> {
  await tx.query(
    `INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'Example assistant', $2)
     ON CONFLICT (client_id) DO NOTHING`,
    [CLIENT_ID, [REDIRECT]],
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO public.mcp_oauth_grants (client_id, client_name, scope, approved_by, approved_at, absolute_expires_at, revoked_at, last_used_at)
     VALUES ($1, 'Example assistant', 'mcp:crm', $2, now() - interval '1 minute', now() + CASE WHEN $3 THEN interval '-1 minute' ELSE interval '30 days' END,
             CASE WHEN $4 THEN now() END, now() - $5::interval)
     RETURNING id`,
    [CLIENT_ID, opts.approvedBy ?? OWNER_ID, opts.expired ?? false, opts.revoked ?? false, opts.lastUsedAgo ?? '1 hour'],
  );
  const grantId = rows[0].id;
  await tx.query(
    `INSERT INTO public.mcp_oauth_tokens (grant_id, token_hash, kind, expires_at) VALUES
       ($1, $2, 'access', now() + interval '10 minutes'), ($1, $3, 'refresh', now() + interval '7 days')`,
    [grantId, opts.access ?? 'access-hash', opts.refresh ?? 'refresh-hash'],
  );
  return grantId;
}

async function auditRows(tx: Tx, action: string): Promise<Array<{ user_id: string; details: Record<string, unknown>; ip_address: string | null }>> {
  return (await tx.query<{ user_id: string; details: Record<string, unknown>; ip_address: string | null }>(
    `SELECT user_id, details, host(ip_address) AS ip_address FROM public.audit_logs WHERE action = $1 ORDER BY created_at`, [action],
  )).rows;
}

// ---------------------------------------------------------------------------
// Who may touch the OAuth tables
// ---------------------------------------------------------------------------

describe('the OAuth tables', () => {
  const sessions: Array<[string, () => Principal]> = [
    ['client A', () => clientA],
    ['client B', () => clientB],
    ['the owner', () => asOwner],
    ['the owner at aal2', () => user(OWNER_ID, { aal: 'aal2' })],
    ['a View-as-client session', () => viewAsClient],
  ];

  it.each(TABLES)('%s: anon and every signed-in session hold no privilege at all', async (table) => {
    const statements = [
      `SELECT 1 FROM public.${table}`,
      `INSERT INTO public.${table} (id) VALUES (gen_random_uuid())`,
      `UPDATE public.${table} SET id = id`,
      `DELETE FROM public.${table}`,
    ];
    for (const sql of statements) {
      await expectDenied(as(db, asAnon, sql));
      for (const [, who] of sessions) await expectDenied(as(db, who(), sql));
    }
  });

  it.each(TABLES)('%s: the server has row access, and no TRUNCATE', async (table) => {
    await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx);
      expect((await tx.query(`SELECT 1 FROM public.${table}`)).rows.length).toBeGreaterThan(table === 'mcp_oauth_requests' ? -1 : 0);
      await tx.query(`UPDATE public.${table} SET id = id`);
      if (table === 'mcp_oauth_tokens') await tx.query(`DELETE FROM public.mcp_oauth_tokens WHERE grant_id = $1`, [grantId]);
    });
    await expectDenied(as(db, asServer, `TRUNCATE public.${table} CASCADE`));
  });

  it.each(TABLES)('%s: RLS on, no permissive policy, and the restrictive MFA gate', async (table) => {
    const { rows } = await db.query<{ rls: boolean; permissive: number; gate: number }>(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive) AS permissive,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive
                 AND p.polname = $2) AS gate
       FROM pg_class c WHERE c.oid = $1::regclass`,
      [`public.${table}`, `${table}_mfa_gate`],
    );
    expect(rows[0]).toEqual({ rls: true, permissive: 0, gate: 1 });
  });
});

// ---------------------------------------------------------------------------
// Who may call what
// ---------------------------------------------------------------------------

const SERVER_FUNCTIONS = [
  'mcp_audit_row(uuid,text,jsonb,text,text)',
  'mcp_oauth_client(text)',
  'mcp_oauth_pending_request(text)',
  'mcp_oauth_decide(text,boolean,text,timestamp with time zone,uuid,text,text)',
  'mcp_oauth_consume_code(text)',
  'mcp_oauth_create_grant(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,uuid,timestamp with time zone,text,text)',
  'mcp_oauth_rotate_refresh(text,text,text,timestamp with time zone,text,timestamp with time zone,text,text)',
  'mcp_oauth_revoke_token(text,text,text)',
  'mcp_oauth_authenticate(text)',
  'mcp_oauth_cleanup()',
  'mcp_tool_vocabulary()',
  'mcp_search_contacts(text,text,integer,uuid,text,text)',
  'mcp_get_contact(uuid,uuid,text,text)',
  'mcp_create_contact(jsonb,uuid,text,text)',
  'mcp_update_contact(uuid,jsonb,uuid,text,text)',
  'mcp_correct_contact_email(uuid,text,text,uuid,text,text)',
  'mcp_add_business(uuid,text,text,uuid,text,text)',
  'mcp_log_call_note(uuid,text,text,uuid,text,text)',
  'mcp_upsert_quote(uuid,uuid,text,text,numeric,uuid,text,text)',
  'mcp_delete_quote(uuid,uuid,uuid,text,uuid,text,text)',
  'mcp_request_snapshot(uuid,uuid,integer)',
  'mcp_list_requests(uuid,integer,uuid,text,text)',
  'mcp_request_keys_active(jsonb)',
  'mcp_request_audit(uuid,text,jsonb,text,text)',
  'mcp_create_request(uuid,text,text,jsonb,uuid,text,text)',
  'mcp_update_request(uuid,uuid,integer,text,text,jsonb,uuid,text,text)',
  'mcp_delete_request(uuid,uuid,integer,uuid,text,text)',
  'mcp_claim_reminder(uuid,uuid)',
  'mcp_release_reminder(uuid,timestamp with time zone,timestamp with time zone)',
];
const OWNER_FUNCTIONS = ['mcp_list_grants()', 'mcp_revoke_grant(uuid)'];

describe('function privileges', () => {
  const can = async (role: string, sig: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `public.${sig}`])).rows[0].ok;

  it('lists every function the migration creates', async () => {
    const { rows } = await db.query<{ sig: string }>(
      `SELECT p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS sig
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'mcp\\_%'`);
    expect(rows.map((r) => r.sig.replace(/, /g, ',')).sort()).toEqual([...SERVER_FUNCTIONS, ...OWNER_FUNCTIONS].sort());
  });

  it.each(SERVER_FUNCTIONS)('%s: the server only', async (sig) => {
    expect(await can('service_role', sig)).toBe(true);
    expect(await can('authenticated', sig)).toBe(false);
    expect(await can('anon', sig)).toBe(false);
    expect(await can('public', sig)).toBe(false);
  });

  it.each(OWNER_FUNCTIONS)('%s: signed-in sessions may call it (it refuses all but the owner), anon may not', async (sig) => {
    expect(await can('authenticated', sig)).toBe(true);
    expect(await can('anon', sig)).toBe(false);
    expect(await can('service_role', sig)).toBe(false);
  });

  it('a signed-in session cannot call a server function, even the owner', async () => {
    for (const who of [asOwner, clientA]) {
      await expectDenied(as(db, who, `SELECT public.mcp_oauth_authenticate('x')`));
      await expectDenied(as(db, who, `SELECT public.mcp_get_contact($1, $2, NULL, NULL)`, [contactA, OWNER_ID]));
    }
    await expectDenied(as(db, asAnon, `SELECT public.mcp_tool_vocabulary()`));
  });

  it('every function pins an empty search_path; only the owner two are definers', async () => {
    const { rows } = await db.query<{ proname: string; definer: boolean; cfg: string[] | null }>(
      `SELECT proname, prosecdef AS definer, proconfig AS cfg FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'mcp\\_%' ORDER BY proname`);
    for (const r of rows) expect([r.proname, (r.cfg ?? []).some((c) => /^search_path=(""|)$/.test(c))]).toEqual([r.proname, true]);
    expect(rows.filter((r) => r.definer).map((r) => r.proname)).toEqual(['mcp_list_grants', 'mcp_revoke_grant']);
  });
});

// ---------------------------------------------------------------------------
// The owner's view of connections
// ---------------------------------------------------------------------------

describe('mcp_list_grants and mcp_revoke_grant', () => {
  async function withGrants<T>(who: Principal, fn: (tx: Tx, ids: { live: string; revoked: string }) => Promise<T>): Promise<T> {
    return session(db, asServer, async (tx) => {
      const live = await seedGrant(tx, { access: 'a1', refresh: 'r1' });
      const revoked = await seedGrant(tx, { access: 'a2', refresh: 'r2', revoked: true });
      await seedGrant(tx, { access: 'a3', refresh: 'r3', expired: true });
      await become(tx, who);
      return fn(tx, { live, revoked });
    });
  }

  it('the owner sees live grants only, with no secret in them', async () => {
    const out = await withGrants(asOwner, async (tx, ids) => ({ list: await call<Array<Record<string, unknown>>>(tx, 'mcp_list_grants'), ids }));
    expect(out.list.map((g) => g.id)).toEqual([out.ids.live]);
    expect(Object.keys(out.list[0]).sort()).toEqual(['client_name', 'created_at', 'expires_at', 'id', 'last_used_at']);
  });

  it('the owner revokes a live grant once, audited as the owner', async () => {
    const out = await withGrants(asOwner, async (tx, ids) => {
      const first = await call<boolean>(tx, 'mcp_revoke_grant', { p_grant_id: ids.live });
      const again = await call<boolean>(tx, 'mcp_revoke_grant', { p_grant_id: ids.live });
      const already = await call<boolean>(tx, 'mcp_revoke_grant', { p_grant_id: ids.revoked });
      await becomeSuperuser(tx);
      return { first, again, already, rows: await auditRows(tx, 'mcp_oauth_revoked'), left: await call<unknown[]>(tx, 'mcp_list_grants').catch(() => null) };
    });
    expect([out.first, out.again, out.already]).toEqual([true, false, false]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].user_id).toBe(OWNER_ID);
    expect(out.rows[0].details).toMatchObject({ source: 'owner' });
  });

  it.each([
    ['client A', () => clientA],
    ['a View-as-client session', () => viewAsClient],
    ['an enrolled owner at aal1', () => user(OWNER_ID, { aal: 'aal1' })],
  ])('%s is refused by both', async (_label, who) => {
    for (const fn of ['mcp_list_grants', 'mcp_revoke_grant']) {
      await expectDenied(
        session(db, asServer, async (tx) => {
          const live = await seedGrant(tx);
          await becomeSuperuser(tx);
          await tx.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER_ID]);
          await become(tx, who());
          return fn === 'mcp_list_grants' ? call(tx, fn) : call(tx, fn, { p_grant_id: live });
        }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// OAuth functions
// ---------------------------------------------------------------------------

describe('mcp_oauth_authenticate', () => {
  it('answers the grant and its approver for a live access token, and NULL otherwise', async () => {
    const out = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { access: 'live' });
      return {
        grantId,
        live: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'live' }),
        unknown: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'nope' }),
        refresh: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'refresh-hash' }),
      };
    });
    expect(out.live).toEqual({ grant_id: out.grantId, actor: OWNER_ID });
    expect(out.unknown).toBeNull();
    expect(out.refresh).toBeNull();
  });

  it.each([
    ['an expired access token', { tokenExpired: true }],
    ['a revoked grant', { revoked: true }],
    ['a grant past its 30 days', { expired: true }],
    ['a grant approved by someone who is not the owner', { approvedBy: SYSTEM_ID }],
  ])('refuses %s', async (_label, opts: { tokenExpired?: boolean; revoked?: boolean; expired?: boolean; approvedBy?: string }) => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { access: 'x', revoked: opts.revoked, expired: opts.expired, approvedBy: opts.approvedBy });
      if (opts.tokenExpired) await tx.query(`UPDATE public.mcp_oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = 'x'`);
      return call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'x' });
    });
    expect(out).toBeNull();
  });

  it('stamps last_used_at only when the last stamp is over five minutes old', async () => {
    const out = await asServerTx(async (tx) => {
      const fresh = await seedGrant(tx, { access: 'fresh', refresh: 'rf', lastUsedAgo: '1 minute' });
      const stale = await seedGrant(tx, { access: 'stale', refresh: 'rs', lastUsedAgo: '10 minutes' });
      const before = (await tx.query<{ id: string; t: string }>(`SELECT id, last_used_at::text AS t FROM public.mcp_oauth_grants`)).rows;
      await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'fresh' });
      await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'stale' });
      const after = (await tx.query<{ id: string; t: string }>(`SELECT id, last_used_at::text AS t FROM public.mcp_oauth_grants`)).rows;
      const at = (rows: typeof before, id: string) => rows.find((r) => r.id === id)!.t;
      return { freshSame: at(before, fresh) === at(after, fresh), staleSame: at(before, stale) === at(after, stale) };
    });
    expect(out).toEqual({ freshSame: true, staleSame: false });
  });
});

describe('mcp_oauth_decide and mcp_oauth_consume_code', () => {
  async function park(tx: Tx, requestId = 'req-1', expiresIn = '10 minutes') {
    await tx.query(
      `INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'Example assistant', $2) ON CONFLICT DO NOTHING`,
      [CLIENT_ID, [REDIRECT]],
    );
    await tx.query(
      `INSERT INTO public.mcp_oauth_requests (request_id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
       VALUES ($1, $2, $3, 'st', 'challenge', 'mcp:crm', 'https://x.example/functions/v1/mcp-crm', now() + $4::interval)`,
      [requestId, CLIENT_ID, REDIRECT, expiresIn],
    );
  }
  const decide = (tx: Tx, approve: boolean, requestId = 'req-1', actor = OWNER_ID) =>
    call(tx, 'mcp_oauth_decide', {
      p_request_id: requestId, p_approve: approve, p_code_hash: approve ? 'code-hash' : null,
      p_code_expires: approve ? later(300_000) : null, p_actor: actor, p_ip: 'not-an-ip', p_user_agent: 'ua',
    });

  it('the pending request reads back with its client name; decided, it is gone', async () => {
    const out = await asServerTx(async (tx) => {
      await park(tx);
      const before = await call<Record<string, unknown>>(tx, 'mcp_oauth_pending_request', { p_request_id: 'req-1' });
      await decide(tx, true);
      return { before, after: await call(tx, 'mcp_oauth_pending_request', { p_request_id: 'req-1' }) };
    });
    expect(out.before).toMatchObject({ request_id: 'req-1', client_name: 'Example assistant', redirect_uri: REDIRECT, scope: 'mcp:crm' });
    expect(out.after).toBeNull();
  });

  it('decides a request exactly once, audited as the owner (an unparsable address is stored as NULL)', async () => {
    const out = await asServerTx(async (tx) => {
      await park(tx);
      const first = await decide(tx, true);
      const second = await decide(tx, false);
      return { first, second, rows: await auditRows(tx, 'mcp_oauth_approved') };
    });
    expect(out.first).toEqual({ redirect_uri: REDIRECT, state: 'st', client_id: CLIENT_ID });
    expect(out.second).toBeNull();
    expect(out.rows).toEqual([{ user_id: OWNER_ID, details: { source: 'mcp_oauth', client_id: CLIENT_ID }, ip_address: null }]);
  });

  it('refuses an expired request, an actor who is not the owner, and an approval with no code', async () => {
    expect(await asServerTx(async (tx) => { await park(tx, 'old', '-1 minute'); return decide(tx, true, 'old'); })).toBeNull();
    await expectDenied(asServerTx(async (tx) => { await park(tx); return decide(tx, true, 'req-1', SYSTEM_ID); }));
    await expect(asServerTx(async (tx) => {
      await park(tx);
      return call(tx, 'mcp_oauth_decide', { p_request_id: 'req-1', p_approve: true, p_code_hash: null, p_code_expires: null, ...audit });
    })).rejects.toThrow(/incomplete_decision/);
  });

  it('a code is consumed once; a denied request and an expired code yield nothing', async () => {
    const out = await asServerTx(async (tx) => {
      await park(tx);
      await decide(tx, true);
      const first = await call<Record<string, unknown>>(tx, 'mcp_oauth_consume_code', { p_code_hash: 'code-hash' });
      const again = await call(tx, 'mcp_oauth_consume_code', { p_code_hash: 'code-hash' });
      await park(tx, 'req-2');
      await decide(tx, false, 'req-2');
      await park(tx, 'req-3');
      await call(tx, 'mcp_oauth_decide', {
        p_request_id: 'req-3', p_approve: true, p_code_hash: 'old-code', p_code_expires: later(-1000), ...audit,
      });
      return { first, again, expired: await call(tx, 'mcp_oauth_consume_code', { p_code_hash: 'old-code' }) };
    });
    expect(out.first).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: 'challenge', approved_by: OWNER_ID });
    expect(out.again).toBeNull();
    expect(out.expired).toBeNull();
  });
});

describe('mcp_oauth_create_grant', () => {
  const grantArgs = (approvedBy: string) => ({
    p_client_id: CLIENT_ID, p_scope: 'mcp:crm', p_access_hash: 'ah', p_access_expires: later(600_000),
    p_refresh_hash: 'rh', p_refresh_expires: later(40 * 86_400_000), p_absolute_expires: later(30 * 86_400_000),
    p_approved_by: approvedBy, p_approved_at: later(-60_000), p_ip: '198.51.100.4', p_user_agent: 'ua',
  });

  it('creates the grant, both tokens (refresh capped at the grant) and the audit row together', async () => {
    const out = await asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'Example assistant', $2)`, [CLIENT_ID, [REDIRECT]]);
      const grantId = await call<string>(tx, 'mcp_oauth_create_grant', grantArgs(OWNER_ID));
      const grant = (await tx.query(`SELECT client_name, approved_by FROM public.mcp_oauth_grants WHERE id = $1`, [grantId])).rows[0];
      const capped = (await tx.query<{ ok: boolean }>(
        `SELECT t.expires_at = g.absolute_expires_at AS ok FROM public.mcp_oauth_tokens t JOIN public.mcp_oauth_grants g ON g.id = t.grant_id
         WHERE t.kind = 'refresh' AND g.id = $1`, [grantId])).rows[0].ok;
      return { grantId, grant, capped, rows: await auditRows(tx, 'mcp_oauth_grant_created') };
    });
    expect(out.grant).toEqual({ client_name: 'Example assistant', approved_by: OWNER_ID });
    expect(out.capped).toBe(true);
    expect(out.rows).toEqual([{ user_id: OWNER_ID, details: { source: 'mcp_oauth', client_id: CLIENT_ID, grant_id: out.grantId }, ip_address: '198.51.100.4' }]);
  });

  it('refuses an approver who is not the owner, and issues nothing', async () => {
    await expectDenied(asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ($1, $2)`, [CLIENT_ID, [REDIRECT]]);
      return call(tx, 'mcp_oauth_create_grant', grantArgs(SYSTEM_ID));
    }));
  });
});

describe('mcp_oauth_rotate_refresh', () => {
  const rotate = (tx: Tx, old: string, next: string, clientId: string | null = CLIENT_ID) =>
    call<{ status: string; scope?: string }>(tx, 'mcp_oauth_rotate_refresh', {
      p_old_hash: old, p_client_id: clientId, p_access_hash: `a-${next}`, p_access_expires: later(600_000), p_refresh_hash: next,
      p_refresh_idle_expires: later(7 * 86_400_000), p_ip: null, p_user_agent: null,
    });

  it('rotates: issues successors, marks the old token rotated, audits as the approver', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { refresh: 'r0' });
      const result = await rotate(tx, 'r0', 'r1');
      const old = (await tx.query<{ rotated: boolean }>(`SELECT rotated_at IS NOT NULL AS rotated FROM public.mcp_oauth_tokens WHERE token_hash = 'r0'`)).rows[0];
      const live = await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'a-r1' });
      return { result, old, live, rows: await auditRows(tx, 'mcp_oauth_refreshed') };
    });
    expect(out.result).toEqual({ status: 'ok', scope: 'mcp:crm' });
    expect(out.old.rotated).toBe(true);
    expect(out.live).not.toBeNull();
    expect(out.rows.map((r) => r.user_id)).toEqual([OWNER_ID]);
  });

  it('a rotated token presented again at once is replay: nothing is issued, and the grant and its successor die', async () => {
    const out = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { refresh: 'r0' });
      await rotate(tx, 'r0', 'r1');
      const replay = await rotate(tx, 'r0', 'r2');
      const minted = (await tx.query(`SELECT 1 FROM public.mcp_oauth_tokens WHERE token_hash IN ('r2', 'a-r2')`)).rows.length;
      const revoked = (await tx.query<{ r: boolean }>(`SELECT revoked_at IS NOT NULL AS r FROM public.mcp_oauth_grants WHERE id = $1`, [grantId])).rows[0].r;
      return {
        replay: replay.status, minted, revoked,
        successorAccess: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'a-r1' }),
        successorRefresh: (await rotate(tx, 'r1', 'r3')).status,
      };
    });
    expect(out).toEqual({ replay: 'replayed', minted: 0, revoked: true, successorAccess: null, successorRefresh: 'invalid' });
  });

  it('a replay revokes the whole grant and is audited, judged even after the token expired', async () => {
    const out = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { refresh: 'r0' });
      await rotate(tx, 'r0', 'r1');
      await tx.query(`UPDATE public.mcp_oauth_tokens SET rotated_at = now() - interval '1 minute', expires_at = now() - interval '1 second' WHERE token_hash = 'r0'`);
      const replay = await rotate(tx, 'r0', 'r9');
      const grant = (await tx.query<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM public.mcp_oauth_grants WHERE id = $1`, [grantId])).rows[0];
      const successor = await rotate(tx, 'r1', 'r10');
      return { replay, grant, successor, rows: await auditRows(tx, 'mcp_oauth_replay_revoked') };
    });
    expect(out.replay).toEqual({ status: 'replayed' });
    expect(out.grant.revoked).toBe(true);
    expect(out.successor).toEqual({ status: 'invalid' });
    expect(out.rows).toHaveLength(1);
  });

  it('refuses an unknown or expired token, and one on a revoked, expired or non-owner grant', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { access: 'e1', refresh: 'expired-r' });
      await tx.query(`UPDATE public.mcp_oauth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = 'expired-r'`);
      await seedGrant(tx, { access: 'e2', refresh: 'revoked-r', revoked: true });
      await seedGrant(tx, { access: 'e3', refresh: 'old-grant-r', expired: true });
      await seedGrant(tx, { access: 'e4', refresh: 'system-r', approvedBy: SYSTEM_ID });
      return Promise.all(['nope', 'expired-r', 'revoked-r', 'old-grant-r', 'system-r'].map(async (h, i) => (await rotate(tx, h, `n${i}`)).status));
    });
    expect(out).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('caps a successor at the grant’s absolute expiry', async () => {
    const ok = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { refresh: 'r0' });
      await tx.query(`UPDATE public.mcp_oauth_grants SET absolute_expires_at = now() + interval '1 day' WHERE id = $1`, [grantId]);
      await rotate(tx, 'r0', 'r1');
      return (await tx.query<{ ok: boolean }>(
        `SELECT t.expires_at = g.absolute_expires_at AS ok FROM public.mcp_oauth_tokens t JOIN public.mcp_oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = 'r1'`,
      )).rows[0].ok;
    });
    expect(ok).toBe(true);
  });

  it('refuses a token presented by another client, leaving the grant and the token usable', async () => {
    const out = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { refresh: 'r0' });
      const other = await rotate(tx, 'r0', 'r1', 'mcpc_' + 'x'.repeat(43));
      const revoked = (await tx.query<{ r: boolean }>(`SELECT revoked_at IS NOT NULL AS r FROM public.mcp_oauth_grants WHERE id = $1`, [grantId])).rows[0].r;
      return { other: other.status, revoked, own: (await rotate(tx, 'r0', 'r2')).status };
    });
    expect(out).toEqual({ other: 'invalid', revoked: false, own: 'ok' });
  });

  it('allows a refresh that names no client: rotation and replay still guard it', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { refresh: 'r0' });
      return (await rotate(tx, 'r0', 'r1', null)).status;
    });
    expect(out).toBe('ok');
  });

  it('an older token in the chain presented again is replay too', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { refresh: 'r0' });
      await rotate(tx, 'r0', 'r1');
      await rotate(tx, 'r1', 'r2');
      return (await rotate(tx, 'r0', 'r3')).status;
    });
    expect(out).toBe('replayed');
  });
});

describe('the approver\u2019s MFA recovery ends every grant made before it', () => {
  const lockout = (tx: Tx, at = "now() + interval '1 second'") =>
    tx.query(`INSERT INTO public.mfa_recovery_lockouts (user_id, revoked_before) VALUES ($1, ${at})`, [OWNER_ID]);

  it('authenticate, rotate and the owner\u2019s list all stop honouring an earlier grant', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { access: 'acc', refresh: 'ref' });
      await becomeSuperuser(tx);
      await lockout(tx);
      await become(tx, asServer);
      const authenticated = await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'acc' });
      const rotated = await call<{ status: string }>(tx, 'mcp_oauth_rotate_refresh', {
        p_old_hash: 'ref', p_client_id: CLIENT_ID, p_access_hash: 'a2', p_access_expires: later(600_000), p_refresh_hash: 'r2',
        p_refresh_idle_expires: later(86_400_000), p_ip: null, p_user_agent: null,
      });
      // A session signed in after the recovery (an older one is itself cut off).
      await become(tx, user(OWNER_ID, { iat: Math.floor(Date.now() / 1000) + 60 }));
      return { authenticated, rotated: rotated.status, listed: await call<unknown[]>(tx, 'mcp_list_grants') };
    });
    expect(out).toEqual({ authenticated: null, rotated: 'invalid', listed: [] });
  });

  it('a grant approved after the recovery is honoured', async () => {
    const out = await asServerTx(async (tx) => {
      await becomeSuperuser(tx);
      await lockout(tx, "now() - interval '1 day'");
      await become(tx, asServer);
      await seedGrant(tx, { access: 'acc' });
      return call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'acc' });
    });
    expect(out).toMatchObject({ actor: OWNER_ID });
  });

  it('judges the approval time, not the grant\u2019s creation: a grant created after the recovery from an earlier approval is dead', async () => {
    const out = await asServerTx(async (tx) => {
      const grantId = await seedGrant(tx, { access: 'acc', refresh: 'ref' });
      await becomeSuperuser(tx);
      await lockout(tx, "now() - interval '30 seconds'");
      // Approved before the recovery, created after it: the interleaving the check must catch.
      await tx.query(`UPDATE public.mcp_oauth_grants SET approved_at = now() - interval '1 minute', created_at = now() WHERE id = $1`, [grantId]);
      await become(tx, asServer);
      return call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'acc' });
    });
    expect(out).toBeNull();
  });

  it('a recovery between the code\u2019s consumption and the grant\u2019s creation issues nothing', async () => {
    const out = await asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ($1, $2)`, [CLIENT_ID, [REDIRECT]]);
      await tx.query(
        `INSERT INTO public.mcp_oauth_requests (request_id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
         VALUES ('req-i', $1, $2, 's', 'c', 'mcp:crm', 'r', now() + interval '5 minutes')`,
        [CLIENT_ID, REDIRECT],
      );
      await call(tx, 'mcp_oauth_decide', {
        p_request_id: 'req-i', p_approve: true, p_code_hash: 'code-i', p_code_expires: later(300_000), ...audit,
      });
      const consumed = await call<{ approved_by: string; approved_at: string }>(tx, 'mcp_oauth_consume_code', { p_code_hash: 'code-i' });
      await becomeSuperuser(tx);
      await lockout(tx);
      await become(tx, asServer);
      const error = await tx.query('SAVEPOINT g').then(async () => {
        try {
          await call(tx, 'mcp_oauth_create_grant', {
            p_client_id: CLIENT_ID, p_scope: 'mcp:crm', p_access_hash: 'ah-i', p_access_expires: later(600_000),
            p_refresh_hash: 'rh-i', p_refresh_expires: later(86_400_000), p_absolute_expires: later(30 * 86_400_000),
            p_approved_by: consumed.approved_by, p_approved_at: consumed.approved_at, p_ip: null, p_user_agent: null,
          });
          return null;
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT g');
          return (err as Error).message;
        }
      });
      const grants = (await tx.query(`SELECT 1 FROM public.mcp_oauth_grants`)).rows.length;
      return { approvedAt: consumed.approved_at !== null, error, grants };
    });
    expect(out.approvedAt).toBe(true);
    expect(out.error).toMatch(/approval_revoked/);
    expect(out.grants).toBe(0);
  });

  it('a code approved before the recovery is burned and yields nothing', async () => {
    const out = await asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ($1, $2)`, [CLIENT_ID, [REDIRECT]]);
      await tx.query(
        `INSERT INTO public.mcp_oauth_requests (request_id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at, status, code_hash, approved_by, approved_at, code_expires_at)
         VALUES ('req-l', $1, $2, 's', 'c', 'mcp:crm', 'r', now() + interval '5 minutes', 'approved', 'code-l', $3, now(), now() + interval '5 minutes')`,
        [CLIENT_ID, REDIRECT, OWNER_ID],
      );
      await becomeSuperuser(tx);
      await lockout(tx);
      await become(tx, asServer);
      const consumed = await call(tx, 'mcp_oauth_consume_code', { p_code_hash: 'code-l' });
      const status = (await tx.query<{ status: string }>(`SELECT status FROM public.mcp_oauth_requests WHERE request_id = 'req-l'`)).rows[0].status;
      return { consumed, status };
    });
    expect(out).toEqual({ consumed: null, status: 'consumed' });
  });
});

describe('mcp_oauth_revoke_token and mcp_oauth_cleanup', () => {
  it('revokes the grant behind any of its tokens; an unknown token is false', async () => {
    const out = await asServerTx(async (tx) => {
      await seedGrant(tx, { access: 'acc', refresh: 'ref' });
      const unknown = await call(tx, 'mcp_oauth_revoke_token', { p_token_hash: 'nope', p_ip: null, p_user_agent: null });
      const known = await call(tx, 'mcp_oauth_revoke_token', { p_token_hash: 'ref', p_ip: null, p_user_agent: null });
      return { unknown, known, live: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'acc' }), rows: await auditRows(tx, 'mcp_oauth_revoked') };
    });
    expect(out).toMatchObject({ unknown: false, known: true, live: null });
    expect(out.rows.map((r) => r.user_id)).toEqual([OWNER_ID]);
  });

  it('removes dead tokens, old requests and orphan clients; keeps live grants’ rotated tokens and clients with a live request', async () => {
    const out = await asServerTx(async (tx) => {
      const live = await seedGrant(tx, { access: 'la', refresh: 'lr' });
      await tx.query(`UPDATE public.mcp_oauth_tokens SET rotated_at = now() - interval '20 days', expires_at = now() - interval '13 days' WHERE token_hash = 'lr'`);
      const dead = await seedGrant(tx, { access: 'da', refresh: 'dr', revoked: true });
      for (const [id, waiting] of [['mcpc_' + 'o'.repeat(43), false], ['mcpc_' + 'w'.repeat(43), true]] as const) {
        await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris, created_at) VALUES ($1, $2, now() - interval '8 days')`, [id, [REDIRECT]]);
        await tx.query(
          `INSERT INTO public.mcp_oauth_requests (request_id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
           VALUES ($1, $2, $3, 's', 'c', 'mcp:crm', 'r', now() + $4::interval)`,
          [`req-${id.slice(5, 6)}`, id, REDIRECT, waiting ? '5 minutes' : '-8 days'],
        );
      }
      await call(tx, 'mcp_oauth_cleanup');
      const tokens = (await tx.query<{ grant_id: string }>(`SELECT grant_id FROM public.mcp_oauth_tokens`)).rows.map((r) => r.grant_id);
      const clients = (await tx.query<{ client_id: string }>(`SELECT client_id FROM public.mcp_oauth_clients ORDER BY 1`)).rows.map((r) => r.client_id);
      return { liveTokens: tokens.filter((g) => g === live).length, deadTokens: tokens.filter((g) => g === dead).length, clients };
    });
    expect(out.liveTokens).toBe(2);
    expect(out.deadTokens).toBe(0);
    expect(out.clients).toEqual([CLIENT_ID, 'mcpc_' + 'w'.repeat(43)].sort());
  });
});

// ---------------------------------------------------------------------------
// The tools' functions
// ---------------------------------------------------------------------------

describe('mcp_tool_vocabulary', () => {
  it('offers every status and only the active business types and services', async () => {
    const out = await asServerTx(async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.service_types SET is_active = false WHERE key = 'consultation'`);
      await tx.query(`UPDATE public.organization_types SET is_active = false WHERE key = 'nonprofit'`);
      await become(tx, asServer);
      return {
        vocab: await call<{ statuses: string[]; organization_types: string[]; service_types: string[] }>(tx, 'mcp_tool_vocabulary'),
        statuses: (await tx.query<{ key: string }>(`SELECT key FROM public.contact_statuses ORDER BY sort_order`)).rows.map((r) => r.key),
      };
    });
    expect(out.vocab.statuses).toEqual(out.statuses);
    expect(out.vocab.service_types).not.toContain('consultation');
    expect(out.vocab.service_types).toContain('retainer');
    expect(out.vocab.organization_types).not.toContain('nonprofit');
  });
});

describe('mcp_search_contacts and mcp_get_contact', () => {
  it('matches a fragment of the full name, email or business name, case-insensitively, with no pattern characters', async () => {
    const out = await asServerTx(async (tx) => {
      const search = (q: string, status: string | null = null) =>
        call<{ count: number; contacts: Array<{ id: string }> }>(tx, 'mcp_search_contacts', { p_query: q, p_status: status, p_limit: 25, ...audit });
      return {
        fullName: (await search('ada LOVE')).contacts.map((c) => c.id),
        business: (await search('acme')).contacts.map((c) => c.id),
        email: (await search('BO@EXAMPLE')).contacts.map((c) => c.id),
        wildcard: (await search('%')).count,
        all: (await search('')).count,
        filtered: (await search('', 'lost')).count,
        rows: await auditRows(tx, 'mcp_search_contacts'),
      };
    });
    expect(out.fullName).toEqual([contactA]);
    expect(out.business).toEqual([contactA]);
    expect(out.email).toEqual([contactB]);
    expect(out.wildcard).toBe(0);
    expect(out.all).toBe(2);
    expect(out.filtered).toBe(0);
    // The query's length, never its text.
    expect(out.rows[0].details).toEqual({ source: 'mcp', query_length: 8, status: null, returned: 1 });
  });

  it('clamps the limit to 1..100 and refuses an unknown status', async () => {
    const one = await asServerTx(async (tx) => call<{ count: number }>(tx, 'mcp_search_contacts', { p_query: '', p_status: null, p_limit: 0, ...audit }));
    expect(one.count).toBe(1);
    await expect(asServerTx((tx) => call(tx, 'mcp_search_contacts', { p_query: '', p_status: 'nope', p_limit: 5, ...audit })))
      .rejects.toThrow(/unknown_status/);
  });

  it('get_contact returns the narrow record with businesses, quotes and the 20 newest notes, audited', async () => {
    const out = await asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.organizations (contact_id, name) VALUES ($1, 'Acme LLC')`, [contactA]);
      for (let i = 0; i < 22; i++) {
        await tx.query(`INSERT INTO public.contact_notes (contact_id, body, created_at) VALUES ($1, $2, now() - $3::interval)`, [contactA, `note ${i}`, `${i} minutes`]);
      }
      return {
        got: await call<Record<string, unknown>>(tx, 'mcp_get_contact', { p_contact_id: contactA, ...audit }),
        missing: await call(tx, 'mcp_get_contact', { p_contact_id: randomUUID(), ...audit }),
        rows: await auditRows(tx, 'mcp_get_contact'),
      };
    });
    expect(Object.keys(out.got).sort()).toEqual(
      ['business_name', 'businesses', 'email', 'first_name', 'id', 'last_name', 'phone', 'quotes', 'recent_notes', 'status'],
    );
    const notes = out.got.recent_notes as Array<{ body: string }>;
    expect(notes).toHaveLength(20);
    expect(notes[0].body).toBe('note 0');
    expect((out.got.businesses as unknown[]).length).toBe(1);
    expect(out.missing).toBeNull();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].details).toEqual({ source: 'mcp', contact_id: contactA });
  });
});

describe('mcp_create_contact and mcp_update_contact', () => {
  it('creates a new lead with default status and source, names defaulting to empty, audited with field names only', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await call<Record<string, unknown>>(tx, 'mcp_create_contact', { p_patch: { email: 'New@Example.com' }, ...audit });
      const row = (await tx.query(`SELECT first_name, last_name, status, source, email FROM public.contacts WHERE id = $1`, [created.id])).rows[0];
      return { created, row, rows: await auditRows(tx, 'mcp_create_contact') };
    });
    expect(out.created).toMatchObject({ outcome: 'created', email: 'New@Example.com', status: 'new_lead' });
    expect(out.row).toEqual({ first_name: '', last_name: '', status: 'new_lead', source: 'other', email: 'New@Example.com' });
    expect(out.rows[0]).toMatchObject({ user_id: OWNER_ID, details: { source: 'mcp', fields: ['email'] }, ip_address: '203.0.113.7' });
  });

  it('refuses a duplicate address, current or older, case-insensitively, and writes nothing', async () => {
    const out = await asServerTx(async (tx) => {
      const current = await call(tx, 'mcp_create_contact', { p_patch: { email: 'ADA@example.com' }, ...audit });
      await tx.query(`UPDATE public.contacts SET email = 'bo.new@example.com' WHERE id = $1`, [contactB]);
      const older = await call(tx, 'mcp_create_contact', { p_patch: { email: 'bo@EXAMPLE.com' }, ...audit });
      return { current, older, count: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.contacts`)).rows[0].n };
    });
    expect(out.current).toEqual({ outcome: 'duplicate', id: contactA });
    expect(out.older).toEqual({ outcome: 'duplicate', id: contactB });
    expect(out.count).toBe(2);
  });

  it('audits a duplicate refusal with its outcome code only', async () => {
    const rows = await asServerTx(async (tx) => {
      await call(tx, 'mcp_create_contact', { p_patch: { email: 'ada@example.com', first_name: 'X' }, ...audit });
      return auditRows(tx, 'mcp_create_contact');
    });
    expect(rows).toEqual([{ user_id: OWNER_ID, details: { source: 'mcp', outcome: 'duplicate' }, ip_address: '203.0.113.7' }]);
  });

  it('update changes only the four base fields, and is NULL for a missing contact', async () => {
    const out = await asServerTx(async (tx) => {
      const updated = await call<Record<string, unknown>>(tx, 'mcp_update_contact', {
        p_contact_id: contactA, p_patch: { phone: '555-0100', email: 'evil@example.com', status: 'client' }, ...audit,
      });
      const row = (await tx.query(`SELECT first_name, phone, email, status FROM public.contacts WHERE id = $1`, [contactA])).rows[0];
      return { updated, row, missing: await call(tx, 'mcp_update_contact', { p_contact_id: randomUUID(), p_patch: { phone: '1' }, ...audit }) };
    });
    expect(out.row).toEqual({ first_name: 'Ada', phone: '555-0100', email: 'ada@example.com', status: 'new_lead' });
    expect(out.missing).toBeNull();
  });
});

describe('mcp_correct_contact_email', () => {
  const correct = (tx: Tx, contactId: string, email: string, expected: string | null) =>
    call<{ outcome: string }>(tx, 'mcp_correct_contact_email', { p_contact_id: contactId, p_email: email, p_expected_current_email: expected, ...audit });

  it('corrects the address, keeps the old one on the email list, and audits without either address', async () => {
    const out = await asServerTx(async (tx) => {
      const contactId = await call<{ id: string }>(tx, 'mcp_create_contact', { p_patch: { email: 'typo@exmaple.com' }, ...audit });
      const result = await correct(tx, contactId.id, 'right@example.com', 'typo@exmaple.com');
      const emails = (await tx.query<{ email: string; is_default: boolean }>(
        `SELECT email, is_default FROM public.contact_emails WHERE contact_id = $1 ORDER BY email`, [contactId.id])).rows;
      return { result, emails, rows: await auditRows(tx, 'mcp_correct_contact_email') };
    });
    expect(out.result).toMatchObject({ outcome: 'updated', email: 'right@example.com' });
    expect(out.emails).toEqual([{ email: 'right@example.com', is_default: true }, { email: 'typo@exmaple.com', is_default: false }]);
    expect(out.rows[0].details).toEqual({ source: 'mcp', contact_id: expect.any(String), had_previous: true });
    expect(JSON.stringify(out.rows)).not.toMatch(/@/);
  });

  it('compares both sides through one canonical form: case, a tab and padding do not make it stale', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await call<{ id: string }>(tx, 'mcp_create_contact', { p_patch: { email: 'x@example.com' }, ...audit });
      await tx.query(`UPDATE public.contacts SET email = E'\\tPad@Example.com ' WHERE id = $1`, [created.id]);
      return correct(tx, created.id, 'pad@example.com', 'pad@example.com');
    });
    expect(out.outcome).toBe('updated');
  });

  it('is stale on a mismatch, matches NULL with NULL, and is not_found for a missing contact', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await call<{ id: string }>(tx, 'mcp_create_contact', { p_patch: { email: 'one@example.com' }, ...audit });
      const stale = await correct(tx, created.id, 'two@example.com', 'other@example.com');
      const staleNull = await correct(tx, created.id, 'two@example.com', null);
      await tx.query(`UPDATE public.contacts SET email = NULL WHERE id = $1`, [created.id]);
      const fromNull = await correct(tx, created.id, 'two@example.com', null);
      return { stale, staleNull, fromNull, missing: await correct(tx, randomUUID(), 'a@example.com', null) };
    });
    expect([out.stale.outcome, out.staleNull.outcome, out.fromNull.outcome, out.missing.outcome]).toEqual(['stale', 'stale', 'updated', 'not_found']);
  });

  it('audits a stale refusal and a portal-account refusal by outcome code, with no address', async () => {
    const out = await asServerTx(async (tx) => {
      const fresh = await call<{ id: string }>(tx, 'mcp_create_contact', { p_patch: { email: 'cy@example.com' }, ...audit });
      await correct(tx, fresh.id, 'x@example.com', 'wrong@example.com');
      await correct(tx, contactA, 'x@example.com', 'ada@example.com');
      return { fresh: fresh.id, rows: await auditRows(tx, 'mcp_correct_contact_email') };
    });
    const details = out.rows.map((r) => r.details).sort((a, b) => String(a.outcome).localeCompare(String(b.outcome)));
    expect(details).toEqual([
      { source: 'mcp', contact_id: contactA, outcome: 'has_portal_account' },
      { source: 'mcp', contact_id: out.fresh, outcome: 'stale' },
    ]);
  });

  it.each(['invited', 'active', 'suspended', 'deactivated'] as const)('refuses a contact with a %s portal account', async (status) => {
    const out = await asServerTx(async (tx) => {
      await becomeSuperuser(tx);
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO public.contacts (first_name, email) VALUES ('Cy', 'cy@example.com') RETURNING id`);
      await tx.query(`INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, $2, 'cy@example.com')`, [rows[0].id, status]);
      await become(tx, asServer);
      return { result: await correct(tx, rows[0].id, 'new@example.com', 'cy@example.com'), email: (await tx.query(`SELECT email FROM public.contacts WHERE id = $1`, [rows[0].id])).rows[0] };
    });
    expect(out.result.outcome).toBe('has_portal_account');
    expect(out.email).toEqual({ email: 'cy@example.com' });
  });
});

describe('mcp_add_business and mcp_log_call_note', () => {
  it('adds a business with its default status, refusing an inactive type and a missing contact', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await call<Record<string, unknown>>(tx, 'mcp_add_business', { p_contact_id: contactA, p_name: 'Acme LLC', p_organization_type: 'llc', ...audit });
      return { created, rows: await auditRows(tx, 'mcp_add_business') };
    });
    expect(out.created).toMatchObject({ name: 'Acme LLC', organization_type: 'llc', status: 'prospect' });
    expect(out.rows[0].details).toEqual({ source: 'mcp', contact_id: contactA, organization_id: out.created.id });
    await expect(asServerTx(async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.organization_types SET is_active = false WHERE key = 'llc'`);
      await become(tx, asServer);
      return call(tx, 'mcp_add_business', { p_contact_id: contactA, p_name: 'X', p_organization_type: 'llc', ...audit });
    })).rejects.toThrow(/mcp_add_business: inactive_type/);
    await expect(asServerTx((tx) => call(tx, 'mcp_add_business', { p_contact_id: randomUUID(), p_name: 'X', p_organization_type: 'llc', ...audit })))
      .rejects.toThrow(/mcp_add_business: not_found/);
  });

  it('appends a note with source mcp, and never for a missing contact', async () => {
    const out = await asServerTx(async (tx) => {
      const logged = await call<{ id: string }>(tx, 'mcp_log_call_note', { p_contact_id: contactA, p_body: 'Discussed the plan', p_kind: 'call', ...audit });
      return (await tx.query(`SELECT source, kind, body FROM public.contact_notes WHERE id = $1`, [logged.id])).rows[0];
    });
    expect(out).toEqual({ source: 'mcp', kind: 'call', body: 'Discussed the plan' });
    await expect(asServerTx((tx) => call(tx, 'mcp_log_call_note', { p_contact_id: randomUUID(), p_body: 'x', p_kind: 'call', ...audit })))
      .rejects.toThrow(/not_found/);
  });
});

describe('mcp_upsert_quote and mcp_delete_quote', () => {
  async function withQuotes<T>(fn: (tx: Tx, ids: { org: string; accepted: string; proposed: string; personal: string }) => Promise<T>) {
    return asServerTx(async (tx) => {
      const org = (await tx.query<{ id: string }>(`INSERT INTO public.organizations (contact_id, name) VALUES ($1, 'Acme LLC') RETURNING id`, [contactA])).rows[0].id;
      const insert = async (orgId: string | null, service: string, state: string) =>
        (await tx.query<{ id: string }>(
          `INSERT INTO public.contact_services (contact_id, organization_id, service_type, state, cadence, amount)
           VALUES ($1, $2, $3, $4, 'monthly', 500) RETURNING id`, [contactA, orgId, service, state])).rows[0].id;
      return fn(tx, {
        org,
        accepted: await insert(org, 'retainer', 'accepted'),
        proposed: await insert(org, 'project', 'proposed'),
        personal: await insert(null, 'project', 'proposed'),
      });
    });
  }
  const upsert = (tx: Tx, org: string | null, service: string, amount = 750) =>
    call<Record<string, unknown>>(tx, 'mcp_upsert_quote', {
      p_contact_id: contactA, p_organization_id: org, p_service_type: service, p_cadence: 'annual', p_amount: amount, ...audit,
    });
  const del = (tx: Tx, quote: string, org: string | null, service: string, contact = contactA) =>
    call<Record<string, unknown>>(tx, 'mcp_delete_quote', {
      p_contact_id: contact, p_quote_id: quote, p_organization_id: org, p_service_type: service, ...audit,
    });

  it('updates the proposed quote on the same business and service, and inserts a new one otherwise, always proposed', async () => {
    const out = await withQuotes(async (tx, ids) => ({
      ids,
      same: await upsert(tx, ids.org, 'project'),
      personal: await upsert(tx, null, 'project', 0),
      fresh: await upsert(tx, null, 'annual_plan'),
      rows: await auditRows(tx, 'mcp_upsert_quote'),
    }));
    expect(out.same).toMatchObject({ id: out.ids.proposed, state: 'proposed', cadence: 'annual', organization_id: out.ids.org });
    expect(out.personal).toMatchObject({ id: out.ids.personal, organization_id: null });
    expect(out.fresh).toMatchObject({ state: 'proposed', service_type: 'annual_plan' });
    expect(out.rows).toHaveLength(3);
  });

  it('never touches an accepted quote, and refuses an inactive service or another contact’s business', async () => {
    await expect(withQuotes((tx, ids) => upsert(tx, ids.org, 'retainer'))).rejects.toThrow(/accepted_quote/);
    const state = await withQuotes(async (tx, ids) => {
      await tx.query('SAVEPOINT s');
      await upsert(tx, ids.org, 'retainer').catch(() => null);
      await tx.query('ROLLBACK TO SAVEPOINT s');
      return (await tx.query(`SELECT state, amount::float AS amount FROM public.contact_services WHERE id = $1`, [ids.accepted])).rows[0];
    });
    expect(state).toEqual({ state: 'accepted', amount: 500 });
    await expect(withQuotes(async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.service_types SET is_active = false WHERE key = 'consultation'`);
      await become(tx, asServer);
      return upsert(tx, null, 'consultation');
    })).rejects.toThrow(/inactive_service/);
    await expect(withQuotes(async (tx) => {
      const other = (await tx.query<{ id: string }>(`INSERT INTO public.organizations (contact_id, name) VALUES ($1, 'Other Co') RETURNING id`, [contactB])).rows[0].id;
      return upsert(tx, other, 'project');
    })).rejects.toThrow(/organization_not_found/);
  });

  it('deletes a proposed quote bound to its service and business, auditing the deleted figures', async () => {
    const out = await withQuotes(async (tx, ids) => ({
      deleted: await del(tx, ids.proposed, ids.org, 'project'),
      left: (await tx.query(`SELECT 1 FROM public.contact_services WHERE id = $1`, [ids.proposed])).rows.length,
      rows: await auditRows(tx, 'mcp_delete_quote'),
      ids,
    }));
    expect(out.left).toBe(0);
    expect(out.rows[0].details).toMatchObject({ quote_id: out.ids.proposed, service_type: 'project', state: 'proposed', cadence: 'monthly', amount: 500, organization_id: out.ids.org });
  });

  it('one not_found for every mismatch: contact, service, business (including NULL for a business quote), unknown id', async () => {
    const cases: Array<(tx: Tx, ids: { org: string; proposed: string; personal: string }) => Promise<unknown>> = [
      (tx, ids) => del(tx, ids.proposed, ids.org, 'project', contactB),
      (tx, ids) => del(tx, ids.proposed, ids.org, 'retainer'),
      (tx, ids) => del(tx, ids.proposed, null, 'project'),
      (tx, ids) => del(tx, ids.personal, ids.org, 'project'),
      (tx, ids) => del(tx, randomUUID(), ids.org, 'project'),
      // A NULL contact must not skip the check (IS DISTINCT FROM, never <>).
      (tx, ids) => call(tx, 'mcp_delete_quote', { p_contact_id: null, p_quote_id: ids.proposed, p_organization_id: ids.org, p_service_type: 'project', ...audit }),
    ];
    for (const run of cases) await expect(withQuotes(run)).rejects.toThrow(/mcp_delete_quote: not_found/);
  });

  it('refuses to delete an accepted quote', async () => {
    await expect(withQuotes((tx, ids) => del(tx, ids.accepted, ids.org, 'retainer'))).rejects.toThrow(/mcp_delete_quote: accepted_quote/);
  });

  it('deletes a quote whose service was deactivated since', async () => {
    const left = await withQuotes(async (tx, ids) => {
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.service_types SET is_active = false WHERE key = 'project'`);
      await become(tx, asServer);
      await del(tx, ids.personal, null, 'project');
      return (await tx.query(`SELECT 1 FROM public.contact_services WHERE id = $1`, [ids.personal])).rows.length;
    });
    expect(left).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The request tools (wave 6b)
// ---------------------------------------------------------------------------

interface SnapshotItem { sort_order: number; kind: string; label: string; description: string | null; required: boolean; sensitive: boolean; category: string; tag: string; fulfilled: boolean }
interface SnapshotList { id: string; status: string; title: string; intro_message: string | null; include_contact_confirm: boolean; content_version: number; items: SnapshotItem[] }
interface Snapshot { contact: { id: string; email: string | null }; lists: SnapshotList[]; truncated: boolean }

const ITEMS = [
  { kind: 'document', label: 'Signed contract', description: null, required: true, category: 'contract', tag: 'business', sensitive: false, sort_order: 0 },
  { kind: 'question', label: 'Account number', description: 'Typed, stored encrypted', required: true, category: 'general', tag: 'general', sensitive: true, sort_order: 1 },
  { kind: 'todo', label: 'Book a call', description: null, required: false, category: 'general', tag: 'general', sensitive: false, sort_order: 2 },
];

const versionOf = async (tx: Tx, id: string) =>
  (await tx.query<{ v: number }>(`SELECT content_version AS v FROM public.needs_lists WHERE id = $1`, [id])).rows[0].v;

/** Run `fn`, rolled back to a savepoint, resolving to its error message (null on success). */
async function attempt(tx: Tx, fn: () => Promise<unknown>): Promise<string | null> {
  await tx.query('SAVEPOINT attempt');
  const err = await fn().then(() => null, (e: Error) => e.message);
  await tx.query('ROLLBACK TO SAVEPOINT attempt');
  return err;
}

describe('mcp_create_request and mcp_update_request', () => {
  const create = (tx: Tx, items: unknown = ITEMS, contact = contactA) =>
    call<{ id: string; status: string; item_count: number }>(tx, 'mcp_create_request', {
      p_contact_id: contact, p_title: 'Onboarding', p_intro: 'Thanks!', p_items: items, ...audit,
    });
  const update = async (tx: Tx, list: string, items: unknown, over: Record<string, unknown> = {}) =>
    call<number>(tx, 'mcp_update_request', {
      p_list_id: list, p_contact_id: contactA, p_expected_version: 'p_expected_version' in over ? over.p_expected_version : await versionOf(tx, list), p_title: 'Onboarding v2', p_intro: null, p_items: items,
      ...audit, ...over,
    });

  it('creates a DRAFT with its items in order, attributed to the actor, invisible to the client, audited with counts', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await create(tx);
      const list = (await tx.query(`SELECT status, sent_at, created_by, title, intro_message FROM public.needs_lists WHERE id = $1`, [created.id])).rows[0];
      const items = (await tx.query(`SELECT kind, label, sort_order, sensitive, status FROM public.needs_items WHERE list_id = $1 ORDER BY sort_order`, [created.id])).rows;
      const rows = await auditRows(tx, 'mcp_create_request');
      await become(tx, clientA);
      const seen = (await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [created.id])).rows.length;
      return { created, list, items, rows, seen };
    });
    expect(out.created).toMatchObject({ status: 'draft', item_count: 3 });
    expect(out.list).toEqual({ status: 'draft', sent_at: null, created_by: OWNER_ID, title: 'Onboarding', intro_message: 'Thanks!' });
    expect(out.items).toEqual([
      { kind: 'document', label: 'Signed contract', sort_order: 0, sensitive: false, status: 'pending' },
      { kind: 'question', label: 'Account number', sort_order: 1, sensitive: true, status: 'pending' },
      { kind: 'todo', label: 'Book a call', sort_order: 2, sensitive: false, status: 'pending' },
    ]);
    expect(out.rows).toEqual([{ user_id: OWNER_ID, ip_address: '203.0.113.7', details: { source: 'mcp', contact_id: contactA, list_id: out.created.id, item_count: 3, sensitive_item_count: 1 } }]);
    expect(out.seen).toBe(0);
  });

  it('is atomic: an item the table refuses leaves no list behind', async () => {
    const out = await asServerTx(async (tx) => ({
      err: await attempt(tx, () => create(tx, [{ ...ITEMS[0], sensitive: true }])),
      lists: (await tx.query(`SELECT 1 FROM public.needs_lists WHERE contact_id = $1`, [contactA])).rows.length,
    }));
    expect(out.err).toMatch(/needs_items_sensitive_question_only/);
    expect(out.lists).toBe(0);
  });

  it('refuses a missing contact, and an inactive category or tag on create and on update', async () => {
    await expect(asServerTx((tx) => create(tx, ITEMS, randomUUID()))).rejects.toThrow(/mcp_create_request: not_found/);
    for (const [table, key, field] of [['request_categories', 'invoice', 'category'], ['request_tags', 'personal', 'tag']] as const) {
      const deactivate = async (tx: Tx) => {
        await becomeSuperuser(tx);
        await tx.query(`UPDATE public.${table} SET is_active = false WHERE key = $1`, [key]);
        await become(tx, asServer);
      };
      await expect(asServerTx(async (tx) => {
        await deactivate(tx);
        return create(tx, [{ ...ITEMS[2], [field]: key }]);
      })).rejects.toThrow(/mcp_create_request: inactive_key/);
      await expect(asServerTx(async (tx) => {
        const { id } = await create(tx);
        await deactivate(tx);
        return update(tx, id, [{ ...ITEMS[2], [field]: key }]);
      })).rejects.toThrow(/mcp_update_request: inactive_key/);
    }
  });

  it('replaces the whole draft: the omitted items go, a NULL intro clears it, the contact-confirm switch is kept', async () => {
    const out = await asServerTx(async (tx) => {
      const { id } = await create(tx);
      await tx.query(`UPDATE public.needs_lists SET include_contact_confirm = true WHERE id = $1`, [id]);
      const count = await update(tx, id, [ITEMS[2]]);
      return {
        count,
        list: (await tx.query(`SELECT title, intro_message, include_contact_confirm, status FROM public.needs_lists WHERE id = $1`, [id])).rows[0],
        labels: (await tx.query(`SELECT label FROM public.needs_items WHERE list_id = $1`, [id])).rows,
        rows: await auditRows(tx, 'mcp_update_request'),
      };
    });
    expect(out.count).toBe(1);
    expect(out.list).toEqual({ title: 'Onboarding v2', intro_message: null, include_contact_confirm: true, status: 'draft' });
    expect(out.labels).toEqual([{ label: 'Book a call' }]);
    expect(out.rows[0].details).toMatchObject({ source: 'mcp', item_count: 1, sensitive_item_count: 0 });
  });

  it('refuses another contact’s draft as not_found and a sent request as not_draft, changing nothing', async () => {
    await expect(asServerTx(async (tx) => {
      const { id } = await create(tx);
      return update(tx, id, [ITEMS[2]], { p_contact_id: contactB });
    })).rejects.toThrow(/needs_replace_draft: not_found/);
    const out = await asServerTx(async (tx) => {
      const { id } = await create(tx);
      await call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: await versionOf(tx, id) });
      const err = await attempt(tx, () => update(tx, id, [ITEMS[2]]));
      return { err, n: (await tx.query(`SELECT 1 FROM public.needs_items WHERE list_id = $1`, [id])).rows.length };
    });
    expect(out.err).toMatch(/needs_replace_draft: not_draft/);
    expect(out.n).toBe(3);
  });

  it('rewrites only the version that was read: an edit since refuses as changed, rewriting and auditing nothing', async () => {
    const out = await asServerTx(async (tx) => {
      const { id } = await create(tx);
      const read = await versionOf(tx, id);
      // The owner's edit lands after the connector read the draft.
      await tx.query(`UPDATE public.needs_lists SET title = 'Owner edit' WHERE id = $1`, [id]);
      const err = await attempt(tx, () => update(tx, id, [ITEMS[2]], { p_expected_version: read }));
      return {
        moved: (await versionOf(tx, id)) !== read,
        err,
        title: (await tx.query<{ title: string }>(`SELECT title FROM public.needs_lists WHERE id = $1`, [id])).rows[0].title,
        n: (await tx.query(`SELECT 1 FROM public.needs_items WHERE list_id = $1`, [id])).rows.length,
        rows: await auditRows(tx, 'mcp_update_request'),
      };
    });
    expect(out).toEqual({ moved: true, err: expect.stringMatching(/mcp_update_request: changed/), title: 'Owner edit', n: 3, rows: [] });
  });

  it('a missing list is not_found, never changed', async () => {
    await expect(asServerTx((tx) => update(tx, randomUUID(), [ITEMS[2]], { p_expected_version: 0 }))).rejects.toThrow(/needs_replace_draft: not_found/);
  });
});

describe('mcp_request_snapshot and mcp_list_requests', () => {
  /** Three lists for contact A (a draft, a sent one partly answered, a closed one) and one for B. */
  async function withLists<T>(fn: (tx: Tx, ids: { draft: string; sent: string; closed: string; other: string }) => Promise<T>) {
    return asServerTx(async (tx) => {
      const mk = async (contact: string, title: string) =>
        (await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contact, p_title: title, p_intro: null, p_items: ITEMS, ...audit })).id;
      const draft = await mk(contactA, 'Draft one');
      const sent = await mk(contactA, 'Sent one');
      const closed = await mk(contactA, 'Closed one');
      const other = await mk(contactB, 'Other contact');
      // One transaction is one now(): distinct times, so newest first is a fact of the data.
      for (const [id, ago] of [[draft, 3], [sent, 2], [closed, 1]] as const) {
        await tx.query(`UPDATE public.needs_lists SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, ago]);
      }
      for (const id of [sent, closed]) await call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: await versionOf(tx, id) });
      await tx.query(`UPDATE public.needs_lists SET status = 'closed' WHERE id = $1`, [closed]);
      // The sent list: the question answered (encrypted), the document uploaded, the to-do open.
      await tx.query(`UPDATE public.needs_items SET answer_ciphertext = '\x01'::bytea, status = 'fulfilled' WHERE list_id = $1 AND kind = 'question'`, [sent]);
      const doc = (await tx.query<{ id: string }>(
        `INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type)
         VALUES ($1, 'a.pdf', 'a.pdf', 'p', 1, 'application/pdf') RETURNING id`, [contactA])).rows[0].id;
      await tx.query(`INSERT INTO public.needs_item_documents (item_id, document_id) SELECT id, $2 FROM public.needs_items WHERE list_id = $1 AND kind = 'document'`, [sent, doc]);
      return fn(tx, { draft, sent, closed, other });
    });
  }
  const snapshot = (tx: Tx, contact: string, list: string | null = null, limit = 25) =>
    call<Snapshot | null>(tx, 'mcp_request_snapshot', { p_contact_id: contact, p_list_id: list, p_limit: limit });

  it('returns the recipient and each list newest first, with every client-visible field and a fulfilled flag', async () => {
    const out = await withLists(async (tx, ids) => ({ ids, snap: await snapshot(tx, contactA) }));
    expect(out.snap!.contact).toEqual({ id: contactA, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' });
    expect(out.snap!.truncated).toBe(false);
    expect(out.snap!.lists.map((l) => l.id)).toEqual([out.ids.closed, out.ids.sent, out.ids.draft]);
    const sent = out.snap!.lists.find((l) => l.id === out.ids.sent)!;
    expect(sent).toMatchObject({ status: 'sent', title: 'Sent one', intro_message: null, include_contact_confirm: false });
    expect(sent.items.map((i) => [i.kind, i.fulfilled])).toEqual([['document', true], ['question', true], ['todo', false]]);
    expect(sent.items[1]).toEqual({ ...ITEMS[1], fulfilled: true });
  });

  it('never returns an answer, typed or encrypted', async () => {
    const text = await withLists(async (tx, ids) => {
      await tx.query(`UPDATE public.needs_items SET answer_text = 'secret-answer-0451' WHERE list_id = $1 AND kind = 'todo'`, [ids.sent]);
      return JSON.stringify(await snapshot(tx, contactA));
    });
    expect(text).not.toContain('secret-answer-0451');
    expect(text).not.toMatch(/answer_text|answer_ciphertext/);
  });

  it('fulfilment item by item agrees with needs_list_progress', async () => {
    const rows = await withLists(async (tx, ids) => {
      // Whitespace is no answer, typed or not: one question holds only spaces, one an answer.
      await tx.query(`INSERT INTO public.needs_items (list_id, kind, label, answer_text, sort_order) VALUES ($1, 'question', 'Blank', '  ', 3), ($1, 'question', 'Typed', 'Yes', 4)`, [ids.draft]);
      const snap = await snapshot(tx, contactA);
      const progress = (await tx.query<{ list_id: string; actionable: number; fulfilled: number }>(
        `SELECT list_id, actionable, fulfilled FROM public.needs_list_progress($1::uuid[])`, [[ids.draft, ids.sent, ids.closed]])).rows;
      return { snap, progress };
    });
    expect(rows.progress).toHaveLength(3);
    for (const p of rows.progress) {
      const list = rows.snap!.lists.find((l) => l.id === p.list_id)!;
      const actionable = list.items.filter((i) => i.kind !== 'info');
      expect([p.list_id, actionable.length, actionable.filter((i) => i.fulfilled).length]).toEqual([p.list_id, p.actionable, p.fulfilled]);
    }
  });

  it('one list of that contact only; another contact’s list reads as none; NULL for no contact', async () => {
    const out = await withLists(async (tx, ids) => ({
      one: await snapshot(tx, contactA, ids.sent),
      cross: await snapshot(tx, contactA, ids.other),
      none: await snapshot(tx, randomUUID()),
      ids,
    }));
    expect(out.one!.lists.map((l) => l.id)).toEqual([out.ids.sent]);
    expect(out.cross!.lists).toEqual([]);
    expect(out.none).toBeNull();
  });

  it('marks a cut-short answer truncated, never silently', async () => {
    const out = await withLists(async (tx) => ({ two: await snapshot(tx, contactA, null, 2), three: await snapshot(tx, contactA, null, 3) }));
    expect([out.two!.lists.length, out.two!.truncated]).toEqual([2, true]);
    expect([out.three!.lists.length, out.three!.truncated]).toEqual([3, false]);
  });

  it('list_requests audits the read in its transaction, and nothing for a missing contact', async () => {
    const out = await withLists(async (tx) => {
      await call(tx, 'mcp_list_requests', { p_contact_id: contactA, p_limit: 2, ...audit });
      const missing = await call(tx, 'mcp_list_requests', { p_contact_id: randomUUID(), p_limit: 2, ...audit });
      return { missing, rows: await auditRows(tx, 'mcp_list_requests') };
    });
    expect(out.missing).toBeNull();
    expect(out.rows.map((r) => r.details)).toEqual([{ source: 'mcp', contact_id: contactA, returned: 2, truncated: true }]);
  });
});

describe('mcp_delete_request', () => {
  async function withDraft<T>(fn: (tx: Tx, id: string, version: number) => Promise<T>) {
    return asServerTx(async (tx) => {
      const { id } = await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contactA, p_title: 'To delete', p_intro: null, p_items: ITEMS, ...audit });
      return fn(tx, id, await versionOf(tx, id));
    });
  }
  const del = (tx: Tx, id: string, version: number, over: Record<string, unknown> = {}) =>
    call<Record<string, unknown>>(tx, 'mcp_delete_request', { p_list_id: id, p_contact_id: contactA, p_expected_version: version, ...audit, ...over });

  it('deletes a draft at the reviewed version, with the requests row and the connector row', async () => {
    const out = await withDraft(async (tx, id, v) => ({
      id, v,
      result: await del(tx, id, v),
      left: (await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [id])).rows.length,
      mcp: await auditRows(tx, 'mcp_delete_request'),
      server: await auditRows(tx, 'needs_list_deleted'),
    }));
    expect(out.result).toEqual({ list_id: out.id, item_count: 3 });
    expect(out.left).toBe(0);
    expect(out.mcp).toEqual([{ user_id: OWNER_ID, ip_address: '203.0.113.7', details: { source: 'mcp', contact_id: contactA, list_id: out.id, item_count: 3, content_version: out.v } }]);
    expect(out.server).toHaveLength(1);
    expect(out.server[0]).toMatchObject({ user_id: OWNER_ID, ip_address: '203.0.113.7' });
  });

  const refusals: Array<[string, string, (tx: Tx, id: string, v: number) => Promise<{ version?: number; over?: Record<string, unknown> }>]> = [
    ['a moved version', 'stale_content', async (_tx, _id, v) => ({ version: v + 1 })],
    ['another contact', 'not_found', async () => ({ over: { p_contact_id: contactB } })],
    ['a sent request', 'not_draft', async (tx, id, v) => {
      await call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: v });
      return {};
    }],
    ['an answer on the draft', 'has_answers', async (tx, id) => {
      await tx.query(`UPDATE public.needs_items SET status = 'fulfilled' WHERE list_id = $1 AND kind = 'todo'`, [id]);
      return {};
    }],
  ];
  it.each(refusals)('refuses %s (%s), deleting nothing', async (_label, sentinel, prepare) => {
    const out = await withDraft(async (tx, id, v) => {
      const p = await prepare(tx, id, v);
      return {
        err: await attempt(tx, () => del(tx, id, p.version ?? v, p.over)),
        left: (await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [id])).rows.length,
      };
    });
    expect(out.err).toBe(sentinel);
    expect(out.left).toBe(1);
  });

  it('a delete whose connector audit row cannot be written does not commit', async () => {
    const out = await withDraft(async (tx, id, v) => ({
      err: await attempt(tx, () => del(tx, id, v, { p_actor: null })),
      left: (await tx.query(`SELECT 1 FROM public.needs_lists WHERE id = $1`, [id])).rows.length,
    }));
    expect(out.err).toMatch(/^mcp_request_audit: failed$/);
    expect(out.left).toBe(1);
  });
});

describe('mcp_claim_reminder and mcp_release_reminder', () => {
  interface Claim { claimed: boolean; stamp?: string; previous?: string | null }
  const sentList = async (tx: Tx) => {
    const { id } = await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contactA, p_title: 'Chase', p_intro: null, p_items: ITEMS, ...audit });
    await call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: await versionOf(tx, id) });
    return id;
  };
  const stampOf = async (tx: Tx, id: string) =>
    (await tx.query<{ at: string | null }>(`SELECT last_reminded_at::text AS at FROM public.needs_lists WHERE id = $1`, [id])).rows[0].at;

  it('claims a sent request once a day, never a draft or another contact’s, and moves no content version', async () => {
    const out = await asServerTx(async (tx) => {
      const { id } = await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contactA, p_title: 'Chase', p_intro: null, p_items: ITEMS, ...audit });
      const claim = async (contact = contactA) => (await call<Claim>(tx, 'mcp_claim_reminder', { p_list_id: id, p_contact_id: contact })).claimed;
      const draft = await claim();
      const v = await versionOf(tx, id);
      await call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: v });
      const other = await claim(contactB);
      const first = await claim();
      const again = await claim();
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = now() - interval '25 hours' WHERE id = $1`, [id]);
      const nextDay = await claim();
      return { draft, other, first, again, nextDay, moved: (await versionOf(tx, id)) !== v };
    });
    expect(out).toEqual({ draft: false, other: false, first: true, again: false, nextDay: true, moved: false });
  });

  it('returns the stamp it wrote and the value it replaced; a release puts the old value back, NULL included', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await sentList(tx);
      const fresh = await call<Claim>(tx, 'mcp_claim_reminder', { p_list_id: id, p_contact_id: contactA });
      const held = await stampOf(tx, id);
      const released = await call<boolean>(tx, 'mcp_release_reminder', { p_list_id: id, p_stamp: fresh.stamp, p_previous: fresh.previous });
      const afterNull = await stampOf(tx, id);
      // Microseconds included: the release compares and restores at full precision.
      const OLD = '2026-01-02 03:04:05.123456+00';
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = $2 WHERE id = $1`, [id, OLD]);
      const old = await call<Claim>(tx, 'mcp_claim_reminder', { p_list_id: id, p_contact_id: contactA });
      await call<boolean>(tx, 'mcp_release_reminder', { p_list_id: id, p_stamp: old.stamp, p_previous: old.previous });
      const same = async (sql: string, params: unknown[]) => (await tx.query<{ ok: boolean }>(sql, params)).rows[0].ok;
      return {
        fresh: { claimed: fresh.claimed, previous: fresh.previous, held: held === fresh.stamp },
        released,
        afterNull,
        previous: await same(`SELECT $1::timestamptz = $2::timestamptz AS ok`, [old.previous, OLD]),
        afterOld: await same(`SELECT last_reminded_at = $2::timestamptz AS ok FROM public.needs_lists WHERE id = $1`, [id, OLD]),
      };
    });
    expect(out).toEqual({
      fresh: { claimed: true, previous: null, held: true },
      released: true,
      afterNull: null,
      previous: true,
      afterOld: true,
    });
  });

  it('never releases over a reminder that went out: once the stamp moved, the release changes nothing', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await sentList(tx);
      const claim = await call<Claim>(tx, 'mcp_claim_reminder', { p_list_id: id, p_contact_id: contactA });
      // The reminder went out and recorded itself.
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = now() + interval '1 second', reminder_count = reminder_count + 1 WHERE id = $1`, [id]);
      const recorded = await stampOf(tx, id);
      const released = await call<boolean>(tx, 'mcp_release_reminder', { p_list_id: id, p_stamp: claim.stamp, p_previous: claim.previous });
      return { released, kept: (await stampOf(tx, id)) === recorded };
    });
    expect(out).toEqual({ released: false, kept: true });
  });
});

describe('mcp_tool_vocabulary: the request pick-lists', () => {
  it('offers only the active request categories and tags', async () => {
    const vocab = await asServerTx(async (tx) => {
      await becomeSuperuser(tx);
      await tx.query(`UPDATE public.request_categories SET is_active = false WHERE key = 'invoice'`);
      await become(tx, asServer);
      return call<{ request_categories: string[]; request_tags: string[] }>(tx, 'mcp_tool_vocabulary');
    });
    expect(vocab.request_categories).toContain('general');
    expect(vocab.request_categories).not.toContain('invoice');
    expect(vocab.request_tags).toEqual(['general', 'personal', 'business']);
  });
});

describe('audit rows', () => {
  it('a write whose audit row cannot be written does not commit', async () => {
    // No actor: audit_logs.user_id is NOT NULL, so the audit insert fails, and the note
    // inserted in the same transaction goes with it.
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.contact_notes`)).rows[0].n;
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await call(tx, 'mcp_log_call_note', { p_contact_id: contactA, p_body: 'x', p_kind: 'call', p_actor: null, p_ip: null, p_user_agent: null });
      }),
    ).rejects.toThrow(/user_id/);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.contact_notes`)).rows[0].n).toBe(before);
  });

  it('every action the connector writes is a valid audit action', async () => {
    const src = (await import('node:fs')).readFileSync('supabase/migrations/0007_mcp.sql', 'utf8');
    const actions = [...src.matchAll(/'(mcp_[a-z_]+)'/g)].map((m) => m[1]).filter((a) => !a.startsWith('mcp_oauth_') || /approved|denied|grant_created|refreshed|revoked|replay/.test(a));
    expect(actions.length).toBeGreaterThan(10);
    for (const a of actions) expect(a).toMatch(/^[a-z][a-z0-9_.]{0,99}$/);
  });
});
