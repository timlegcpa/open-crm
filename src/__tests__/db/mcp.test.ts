// @vitest-environment node
// 0007_mcp and 0015_mcp on the real migrations: who may touch the OAuth tables and call the
// connector's functions, and what each function does. Every call runs as the role that makes it in
// production (service_role for the edge functions, a signed-in session for the owner's two)
// inside a transaction that is rolled back, so each test starts from the same fixtures.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { isReminderDue } from '../../../supabase/functions/needs-reminder-dispatcher/handler';
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
  // The contacts archive column arrives with the contacts domain's own migration (0013);
  // added here only when this tree does not carry it yet, so the suite runs either way.
  await db.query('ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS archived_at timestamptz');
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
/** The consent version the screen states (src/features/mcp/pages.tsx); a test below holds it equal to mcp_consent_version(). */
const CONSENT = Number(/export const CONSENT_VERSION = (\d+);/.exec(readFileSync('src/features/mcp/pages.tsx', 'utf8'))?.[1]);

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
    `INSERT INTO public.mcp_oauth_grants (client_id, client_name, scope, approved_by, approved_at, absolute_expires_at, revoked_at, last_used_at, consent_version)
     VALUES ($1, 'Example assistant', 'mcp:crm', $2, now() - interval '1 minute', now() + CASE WHEN $3 THEN interval '-1 minute' ELSE interval '30 days' END,
             CASE WHEN $4 THEN now() END, now() - $5::interval, public.mcp_consent_version())
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
  'mcp_oauth_decide(text,boolean,text,timestamp with time zone,integer,uuid,text,text)',
  'mcp_oauth_consume_code(text)',
  'mcp_oauth_create_grant(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,uuid,timestamp with time zone,integer,text,text)',
  'mcp_oauth_rotate_refresh(text,text,text,timestamp with time zone,text,timestamp with time zone,text,text)',
  'mcp_oauth_revoke_token(text,text,text)',
  'mcp_oauth_authenticate(text)',
  'mcp_oauth_cleanup()',
  'mcp_tool_vocabulary()',
  'mcp_consent_version()',
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
  // 0015_mcp.
  'mcp_set_contact_status(uuid,text,text,uuid,text,text)',
  'mcp_list_board(text,uuid,integer,uuid,text,text)',
  'mcp_work_item_contact_ok(uuid,text)',
  'mcp_create_work_item(text,uuid,text,text,text,date,uuid,text,text)',
  'mcp_update_work_item(uuid,jsonb,uuid,text,text)',
  'mcp_move_work_item(uuid,text,text,text,uuid,text,text)',
  'mcp_add_work_item_note(uuid,text,uuid,text,text)',
  'mcp_close_request(uuid,uuid,uuid,text,text)',
  'mcp_accept_request(uuid,uuid,uuid,text,text)',
  'mcp_set_request_reminders(uuid,uuid,boolean,uuid,text,text)',
  'mcp_list_open_requests(integer,uuid,text,text)',
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
      await expectDenied(as(db, who, `SELECT public.mcp_set_contact_status($1, 'client', 'new_lead', $2, NULL, NULL)`, [contactA, OWNER_ID]));
      await expectDenied(as(db, who, `SELECT public.mcp_close_request($1, $2, $3, NULL, NULL)`, [randomUUID(), contactA, OWNER_ID]));
      await expectDenied(as(db, who, `SELECT public.mcp_list_board(NULL, NULL, 10, $1, NULL, NULL)`, [OWNER_ID]));
    }
    // A View-as-client session is a client session: refused like one.
    await expectDenied(as(db, viewAsClient, `SELECT public.mcp_accept_request($1, $2, $3, NULL, NULL)`, [randomUUID(), contactA, OWNER_ID]));
    await expectDenied(as(db, asAnon, `SELECT public.mcp_list_open_requests(10, $1, NULL, NULL)`, [OWNER_ID]));
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
      p_code_expires: approve ? later(300_000) : null, p_consent_version: approve ? CONSENT : null, p_actor: actor, p_ip: 'not-an-ip', p_user_agent: 'ua',
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
      return call(tx, 'mcp_oauth_decide', { p_request_id: 'req-1', p_approve: true, p_code_hash: null, p_code_expires: null, p_consent_version: CONSENT, ...audit });
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
        p_request_id: 'req-3', p_approve: true, p_code_hash: 'old-code', p_code_expires: later(-1000), p_consent_version: CONSENT, ...audit,
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
    p_approved_by: approvedBy, p_approved_at: later(-60_000), p_consent_version: CONSENT, p_ip: '198.51.100.4', p_user_agent: 'ua',
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

describe('the consent version is bound to the approval', () => {
  async function parked(tx: Tx, requestId: string) {
    await tx.query(
      `INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'Example assistant', $2) ON CONFLICT DO NOTHING`,
      [CLIENT_ID, [REDIRECT]],
    );
    await tx.query(
      `INSERT INTO public.mcp_oauth_requests (request_id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
       VALUES ($1, $2, $3, 'st', 'challenge', 'mcp:crm', 'r', now() + interval '10 minutes')`,
      [requestId, CLIENT_ID, REDIRECT],
    );
  }
  const approve = (tx: Tx, requestId: string, version: number | null) =>
    call(tx, 'mcp_oauth_decide', {
      p_request_id: requestId, p_approve: true, p_code_hash: `code-${requestId}`, p_code_expires: later(300_000),
      p_consent_version: version, ...audit,
    });
  /** The exchange as mcp-oauth runs it: consume, then write the grant with what the consume handed on. */
  async function exchange(tx: Tx, requestId: string) {
    const consumed = await call<{ approved_by: string; approved_at: string; consent_version: number | null }>(
      tx, 'mcp_oauth_consume_code', { p_code_hash: `code-${requestId}` });
    // A savepoint kept on success (attempt() always rolls back), undone only on a refusal.
    await tx.query('SAVEPOINT exchange');
    const error = await Promise.resolve(
      call(tx, 'mcp_oauth_create_grant', {
        p_client_id: CLIENT_ID, p_scope: 'mcp:crm', p_access_hash: `ah-${requestId}`, p_access_expires: later(600_000),
        p_refresh_hash: `rh-${requestId}`, p_refresh_expires: later(86_400_000), p_absolute_expires: later(30 * 86_400_000),
        p_approved_by: consumed.approved_by, p_approved_at: consumed.approved_at, p_consent_version: consumed.consent_version,
        p_ip: null, p_user_agent: null,
      }),
    ).then(
      async () => { await tx.query('RELEASE SAVEPOINT exchange'); return null; },
      async (e: Error) => { await tx.query('ROLLBACK TO SAVEPOINT exchange'); return e.message; },
    );
    const grants = (await tx.query<{ consent_version: number }>(`SELECT consent_version FROM public.mcp_oauth_grants`)).rows;
    return { handedOn: consumed.consent_version, error, grants };
  }

  it('the screen and the database state the same version', async () => {
    const v = await asServerTx(async (tx) => (await tx.query<{ v: number }>(`SELECT public.mcp_consent_version() AS v`)).rows[0].v);
    expect(Number.isInteger(CONSENT)).toBe(true);
    expect(v).toBe(CONSENT);
  });

  it('an approval on any other version is refused and the request stays pending', async () => {
    const out = await asServerTx(async (tx) => {
      await parked(tx, 'req-old');
      const older = await attempt(tx, () => approve(tx, 'req-old', CONSENT - 1));
      const none = await attempt(tx, () => approve(tx, 'req-old', null));
      const row = (await tx.query(`SELECT status, code_hash, consent_version FROM public.mcp_oauth_requests WHERE request_id = 'req-old'`)).rows[0];
      return { older, none, row, audit: await auditRows(tx, 'mcp_oauth_approved') };
    });
    expect(out.older).toMatch(/mcp_oauth_decide: stale_consent/);
    expect(out.none).toMatch(/mcp_oauth_decide: stale_consent/);
    expect(out.row).toEqual({ status: 'pending', code_hash: null, consent_version: null });
    expect(out.audit).toEqual([]);
  });

  it('an approval on the current version is stored on the request and becomes a grant of that version', async () => {
    const out = await asServerTx(async (tx) => {
      await parked(tx, 'req-now');
      await approve(tx, 'req-now', CONSENT);
      const stored = (await tx.query(`SELECT consent_version FROM public.mcp_oauth_requests WHERE request_id = 'req-now'`)).rows[0];
      return { stored, ...(await exchange(tx, 'req-now')) };
    });
    expect(out.stored).toEqual({ consent_version: CONSENT });
    expect(out.handedOn).toBe(CONSENT);
    expect(out.error).toBeNull();
    expect(out.grants).toEqual([{ consent_version: CONSENT }]);
  });

  it('a request decided on version N cannot yield a grant once the version is bumped', async () => {
    const out = await asServerTx(async (tx) => {
      await parked(tx, 'req-bump');
      await approve(tx, 'req-bump', CONSENT);
      // The upgrade lands between the approval and the code exchange (rolled back with the test).
      await becomeSuperuser(tx);
      await tx.exec(`CREATE OR REPLACE FUNCTION public.mcp_consent_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT ${CONSENT + 1} $$`);
      await become(tx, asServer);
      return exchange(tx, 'req-bump');
    });
    expect(out.handedOn).toBe(CONSENT);
    expect(out.error).toMatch(/mcp_oauth_create_grant: stale_consent/);
    expect(out.grants).toEqual([]);
  });

  it('an approval stored before versions were recorded (NULL) yields no grant, and its code stays burned', async () => {
    const out = await asServerTx(async (tx) => {
      await parked(tx, 'req-pre');
      await becomeSuperuser(tx);
      await tx.query(
        `UPDATE public.mcp_oauth_requests SET status = 'approved', code_hash = 'code-req-pre', approved_by = $1, approved_at = now(),
                code_expires_at = now() + interval '5 minutes' WHERE request_id = 'req-pre'`, [OWNER_ID]);
      await become(tx, asServer);
      const result = await exchange(tx, 'req-pre');
      const status = (await tx.query(`SELECT status FROM public.mcp_oauth_requests WHERE request_id = 'req-pre'`)).rows[0];
      return { ...result, status };
    });
    expect(out.handedOn).toBeNull();
    expect(out.error).toMatch(/mcp_oauth_create_grant: stale_consent/);
    expect(out.grants).toEqual([]);
    expect(out.status).toEqual({ status: 'consumed' });
  });

  it('a grant cannot be written without a version: the column has no default', async () => {
    const error = await asServerTx(async (tx) => {
      await tx.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ($1, $2)`, [CLIENT_ID, [REDIRECT]]);
      return attempt(tx, () => tx.query(
        `INSERT INTO public.mcp_oauth_grants (client_id, scope, approved_by, approved_at, absolute_expires_at)
         VALUES ($1, 'mcp:crm', $2, now(), now() + interval '30 days')`, [CLIENT_ID, OWNER_ID]));
    });
    expect(error).toMatch(/consent_version/);
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
        p_request_id: 'req-i', p_approve: true, p_code_hash: 'code-i', p_code_expires: later(300_000), p_consent_version: CONSENT, ...audit,
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
            p_approved_by: consumed.approved_by, p_approved_at: consumed.approved_at, p_consent_version: CONSENT, p_ip: null, p_user_agent: null,
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
/** Publish a draft at a version, to the contact and address it goes to now (needs_send_list). */
const publish = async (tx: Tx, id: string, version: number) => {
  const { contact_id, email } = (await tx.query<{ contact_id: string; email: string }>(
    `SELECT l.contact_id, lower(btrim(c.email)) AS email FROM public.needs_lists l JOIN public.contacts c ON c.id = l.contact_id WHERE l.id = $1`, [id])).rows[0];
  return call(tx, 'needs_send_list', { p_list_id: id, p_expected_version: version, p_contact_id: contact_id, p_email: email });
};

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
      await publish(tx, id, await versionOf(tx, id));
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
      for (const id of [sent, closed]) await publish(tx, id, await versionOf(tx, id));
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
    expect(sent.items[1]).toEqual({ ...ITEMS[1], status: 'fulfilled', fulfilled: true });
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
      await publish(tx, id, v);
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
  interface Shared { status: string; previous?: string | null }
  interface Row { status: 'sent'; reminder_count: number; last_reminded_at: string | null; mcp: string | null; sent_at: string; reminders_paused: boolean }
  const sentList = async (tx: Tx) => {
    const { id } = await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contactA, p_title: 'Chase', p_intro: null, p_items: ITEMS, ...audit });
    await publish(tx, id, await versionOf(tx, id));
    return id;
  };
  const rowOf = async (tx: Tx, id: string) =>
    (await tx.query<Row>(
      `SELECT status, reminder_count, last_reminded_at::text AS last_reminded_at, mcp_reminder_claimed_at::text AS mcp, sent_at::text AS sent_at, reminders_paused
         FROM public.needs_lists WHERE id = $1`, [id])).rows[0];
  const dayClaim = (tx: Tx, id: string, contact = contactA) => call<Claim>(tx, 'mcp_claim_reminder', { p_list_id: id, p_contact_id: contact });
  const dayRelease = (tx: Tx, id: string, c: Claim) => call<boolean>(tx, 'mcp_release_reminder', { p_list_id: id, p_stamp: c.stamp, p_previous: c.previous });
  const sharedClaim = (tx: Tx, id: string, count: number) => call<Shared>(tx, 'needs_claim_reminder', { p_list_id: id, p_expected_count: count });
  const sharedRelease = (tx: Tx, id: string, count: number, previous: string | null | undefined) =>
    call<boolean>(tx, 'needs_release_reminder', { p_list_id: id, p_claimed_count: count, p_previous: previous ?? null });

  it('claims a sent request once a day, never a draft or another contact’s, and moves no content version', async () => {
    const out = await asServerTx(async (tx) => {
      const { id } = await call<{ id: string }>(tx, 'mcp_create_request', { p_contact_id: contactA, p_title: 'Chase', p_intro: null, p_items: ITEMS, ...audit });
      const draft = (await dayClaim(tx, id)).claimed;
      const v = await versionOf(tx, id);
      await publish(tx, id, v);
      const other = (await dayClaim(tx, id, contactB)).claimed;
      const first = (await dayClaim(tx, id)).claimed;
      const again = (await dayClaim(tx, id)).claimed;
      await tx.query(`UPDATE public.needs_lists SET mcp_reminder_claimed_at = now() - interval '25 hours' WHERE id = $1`, [id]);
      const nextDay = (await dayClaim(tx, id)).claimed;
      return { draft, other, first, again, nextDay, moved: (await versionOf(tx, id)) !== v };
    });
    expect(out).toEqual({ draft: false, other: false, first: true, again: false, nextDay: true, moved: false });
  });

  it('refuses within a day of anyone’s reminder, and writes only its own column', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await sentList(tx);
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = now() - interval '2 hours' WHERE id = $1`, [id]);
      const recent = (await dayClaim(tx, id)).claimed;
      await tx.query(`UPDATE public.needs_lists SET last_reminded_at = now() - interval '25 hours' WHERE id = $1`, [id]);
      const before = await rowOf(tx, id);
      const claim = await dayClaim(tx, id);
      const after = await rowOf(tx, id);
      return { recent, claimed: claim.claimed, untouched: [after.last_reminded_at, after.reminder_count], was: [before.last_reminded_at, before.reminder_count], held: after.mcp === claim.stamp };
    });
    expect(out.recent).toBe(false);
    expect(out.claimed).toBe(true);
    expect(out.untouched).toEqual(out.was);
    expect(out.held).toBe(true);
  });

  it('a release puts the previous day stamp back, NULL included, only while it holds this claim', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await sentList(tx);
      const fresh = await dayClaim(tx, id);
      const released = await dayRelease(tx, id, fresh);
      const afterNull = (await rowOf(tx, id)).mcp;
      // Microseconds included: the release compares and restores at full precision.
      const OLD = '2026-01-02 03:04:05.123456+00';
      await tx.query(`UPDATE public.needs_lists SET mcp_reminder_claimed_at = $2 WHERE id = $1`, [id, OLD]);
      const old = await dayClaim(tx, id);
      await dayRelease(tx, id, old);
      const restored = (await tx.query<{ ok: boolean }>(`SELECT mcp_reminder_claimed_at = $2::timestamptz AS ok FROM public.needs_lists WHERE id = $1`, [id, OLD])).rows[0].ok;
      // A stale stamp hands back nothing.
      const again = await dayClaim(tx, id);
      const stale = await dayRelease(tx, id, { ...again, stamp: '2026-01-01 00:00:00+00' });
      return { fresh: [fresh.claimed, fresh.previous], released, afterNull, restored, stale, kept: (await rowOf(tx, id)).mcp === again.stamp };
    });
    expect(out).toEqual({ fresh: [true, null], released: true, afterNull: null, restored: true, stale: false, kept: true });
  });

  it('with the shared claim: a delivered reminder keeps both stamps, a failed one gives both back', async () => {
    const out = await asServerTx(async (tx) => {
      const run = async (delivered: boolean) => {
        const id = await sentList(tx);
        const day = await dayClaim(tx, id);
        const shared = await sharedClaim(tx, id, 0);
        if (!delivered) {
          await sharedRelease(tx, id, 0, shared.previous);
          await dayRelease(tx, id, day);
        }
        const row = await rowOf(tx, id);
        return { shared: shared.status, count: row.reminder_count, reminded: row.last_reminded_at !== null, day: row.mcp !== null };
      };
      return { delivered: await run(true), failed: await run(false) };
    });
    expect(out).toEqual({
      delivered: { shared: 'claimed', count: 1, reminded: true, day: true },
      failed: { shared: 'claimed', count: 0, reminded: false, day: false },
    });
  });

  it('the reviewer’s interleaving: an owner reminder in progress whose email fails leaves nothing postponed', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await sentList(tx);
      const settings = { enabled: true, interval_days: 7, max_reminders: 3 };
      const due = (row: Row) => {
        const now = new Date(new Date(row.sent_at).getTime() + 8 * 24 * 60 * 60 * 1000);
        return isReminderDue({ ...row, id, contact_id: contactA, title: 'Chase', intro_message: null, content_version: 0 }, settings, now);
      };
      const before = await rowOf(tx, id);
      // 1. The connector claims the day.
      const day = await dayClaim(tx, id);
      // 2. The owner's Remind takes the shared claim.
      const owner = await sharedClaim(tx, id, 0);
      // 3. The connector's shared claim finds it in progress; it hands its day back.
      const connector = await sharedClaim(tx, id, 0);
      const dayBack = await dayRelease(tx, id, day);
      // 4. The owner's email fails; it gives its count and stamp back.
      const ownerBack = await sharedRelease(tx, id, 0, owner.previous);
      const after = await rowOf(tx, id);
      return {
        steps: [day.claimed, owner.status, connector.status, dayBack, ownerBack],
        after: { count: after.reminder_count, last_reminded_at: after.last_reminded_at, mcp: after.mcp },
        due: [due(before), due(after)],
        // Nothing went out, so the connector may remind again at once.
        again: (await dayClaim(tx, id)).claimed,
      };
    });
    expect(out).toEqual({
      steps: [true, 'claimed', 'in_progress', true, true],
      after: { count: 0, last_reminded_at: null, mcp: null },
      due: [true, true],
      again: true,
    });
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
    const fs = await import('node:fs');
    const src = ['0007_mcp.sql', '0015_mcp.sql'].map((f) => fs.readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');
    const actions = [...src.matchAll(/'(mcp_[a-z_]+)'/g)].map((m) => m[1]).filter((a) => !a.startsWith('mcp_oauth_') || /approved|denied|grant_created|refreshed|revoked|replay/.test(a));
    expect(actions.length).toBeGreaterThan(10);
    for (const a of actions) expect(a).toMatch(/^[a-z][a-z0-9_.]{0,99}$/);
  });
});

// ---------------------------------------------------------------------------
// 0015_mcp: the pipeline, the work board and the request follow-up
// ---------------------------------------------------------------------------

/** As the database superuser for setup, then back to the server for the call under test. */
async function asSetup(tx: Tx, sql: string, params: unknown[] = []) {
  await becomeSuperuser(tx);
  const rows = (await tx.query<Record<string, unknown>>(sql, params)).rows;
  await become(tx, asServer);
  return rows;
}

describe('mcp_tool_vocabulary: the pipeline and the board', () => {
  it('offers every stage but the system one, with labels; the lead sources a model may set; the lanes with labels; the active card types', async () => {
    const out = await asServerTx(async (tx) => {
      await asSetup(tx, `UPDATE public.lead_sources SET is_active = false WHERE key = 'event'`);
      await asSetup(tx, `UPDATE public.work_item_types SET is_active = false WHERE key = 'meeting'`);
      await asSetup(tx, `UPDATE public.board_stages SET label = 'Doing now' WHERE key = 'doing'`);
      return {
        vocab: await call<{
          selectable_statuses: Array<{ key: string; label: string }>; lead_sources: string[];
          board_stages: Array<{ key: string; label: string }>; work_item_types: string[];
        }>(tx, 'mcp_tool_vocabulary'),
        statuses: (await tx.query<{ key: string; label: string }>(`SELECT key, label FROM public.contact_statuses ORDER BY sort_order, key`)).rows,
      };
    });
    expect(out.vocab.selectable_statuses).toEqual(out.statuses.filter((s) => s.key !== 'esign_signer'));
    expect(out.vocab.selectable_statuses.map((s) => s.key)).not.toContain('esign_signer');
    expect(out.vocab.lead_sources).toContain('referral');
    expect(out.vocab.lead_sources).toContain('other');
    for (const key of ['event', 'lead_intake', 'esign']) expect(out.vocab.lead_sources).not.toContain(key);
    expect(out.vocab.board_stages).toEqual([
      { key: 'todo', label: 'To do' }, { key: 'waiting', label: 'Waiting' }, { key: 'doing', label: 'Doing now' }, { key: 'done', label: 'Done' },
    ]);
    expect(out.vocab.work_item_types).toContain('task');
    expect(out.vocab.work_item_types).not.toContain('meeting');
  });
});

describe('mcp_search_contacts: phone and archive', () => {
  it('matches a run of the phone as stored, and never returns an archived contact', async () => {
    const out = await asServerTx(async (tx) => {
      await asSetup(tx, `UPDATE public.contacts SET phone = '(555) 010-4477' WHERE id = $1`, [contactB]);
      const search = (q: string) =>
        call<{ contacts: Array<{ id: string }> }>(tx, 'mcp_search_contacts', { p_query: q, p_status: null, p_limit: 25, ...audit });
      const byPhone = (await search('4477')).contacts.map((c) => c.id);
      await asSetup(tx, `UPDATE public.contacts SET archived_at = now() WHERE id = $1`, [contactB]);
      return {
        byPhone,
        archivedByPhone: (await search('4477')).contacts.map((c) => c.id),
        archivedByName: (await search('baker')).contacts.map((c) => c.id),
        all: (await search('')).contacts.map((c) => c.id),
      };
    });
    expect(out.byPhone).toEqual([contactB]);
    expect(out.archivedByPhone).toEqual([]);
    expect(out.archivedByName).toEqual([]);
    expect(out.all).toEqual([contactA]);
  });
});

describe('mcp_create_contact: email or phone, stage and source', () => {
  const create = (tx: Tx, patch: Record<string, unknown>) => call<Record<string, unknown>>(tx, 'mcp_create_contact', { p_patch: patch, ...audit });

  it('creates a lead from a phone alone, with no address and no duplicate check on the phone', async () => {
    const out = await asServerTx(async (tx) => {
      const first = await create(tx, { phone: '555 0100', first_name: 'Grace' });
      const second = await create(tx, { phone: '555 0100' });
      const row = (await tx.query(`SELECT email, phone, status, source FROM public.contacts WHERE id = $1`, [first.id])).rows[0];
      return { first, second, row };
    });
    expect(out.first).toMatchObject({ outcome: 'created', email: null, phone: '555 0100', status: 'new_lead', source: 'other' });
    expect(out.second).toMatchObject({ outcome: 'created' });
    expect(out.row).toEqual({ email: null, phone: '555 0100', status: 'new_lead', source: 'other' });
  });

  it('records the stage and source given; a client stage stamps client_since and one history entry, through the trigger', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await create(tx, { email: 'grace@example.com', status: 'client', source: 'referral' });
      const row = (await tx.query<{ status: string; source: string; client_since: string | null; status_history: unknown[] }>(
        `SELECT status, source, client_since::text, status_history FROM public.contacts WHERE id = $1`, [created.id])).rows[0];
      return { row, rows: await auditRows(tx, 'mcp_create_contact') };
    });
    expect(out.row).toMatchObject({ status: 'client', source: 'referral' });
    expect(out.row.client_since).not.toBeNull();
    expect(out.row.status_history).toHaveLength(1);
    // The lead source sits under its own key: details.source is the audit's own ('mcp').
    expect(out.rows[0].details).toMatchObject({ source: 'mcp', status: 'client', lead_source: 'referral' });
  });

  it.each([
    ['neither an address nor a phone', {}, /email_or_phone_required/],
    ['a blank address and a blank phone', { email: ' ', phone: '' }, /email_or_phone_required/],
    ['the system status', { phone: '1', status: 'esign_signer' }, /invalid_status/],
    ['an unknown status', { phone: '1', status: 'made_up' }, /invalid_status/],
    ['a source the code assigns', { phone: '1', source: 'lead_intake' }, /inactive_source/],
    ['the e-signature source', { phone: '1', source: 'esign' }, /inactive_source/],
    ['an unknown source', { phone: '1', source: 'made_up' }, /inactive_source/],
  ])('refuses %s, writing nothing', async (_label, patch, error) => {
    const out = await asServerTx(async (tx) => {
      const before = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.contacts`)).rows[0].n;
      const err = await attempt(tx, () => create(tx, patch));
      return { err, before, after: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.contacts`)).rows[0].n };
    });
    expect(out.err).toMatch(error);
    expect(out.after).toBe(out.before);
  });

  it('refuses a source the owner retired', async () => {
    const err = await asServerTx(async (tx) => {
      await asSetup(tx, `UPDATE public.lead_sources SET is_active = false WHERE key = 'referral'`);
      return attempt(tx, () => create(tx, { phone: '1', source: 'referral' }));
    });
    expect(err).toMatch(/inactive_source/);
  });
});

describe('mcp_set_contact_status', () => {
  const move = (tx: Tx, contact: string, status: string, expected: string) =>
    call<Record<string, unknown>>(tx, 'mcp_set_contact_status', { p_contact_id: contact, p_status: status, p_expected_status: expected, ...audit });

  it('moves the stage on a matching read; the trigger appends the history and stamps client_since', async () => {
    const out = await asServerTx(async (tx) => {
      const before = (await tx.query<{ h: unknown[] }>(`SELECT status_history AS h FROM public.contacts WHERE id = $1`, [contactA])).rows[0].h.length;
      const result = await move(tx, contactA, 'client', 'new_lead');
      const row = (await tx.query<{ status: string; client_since: string | null; h: Array<{ status: string }> }>(
        `SELECT status, client_since::text, status_history AS h FROM public.contacts WHERE id = $1`, [contactA])).rows[0];
      return { before, result, row, rows: await auditRows(tx, 'mcp_set_contact_status') };
    });
    expect(out.result).toMatchObject({ outcome: 'updated', id: contactA, from: 'new_lead', status: 'client' });
    expect(out.row.status).toBe('client');
    expect(out.row.client_since).not.toBeNull();
    expect(out.row.h).toHaveLength(out.before + 1);
    expect(out.row.h.at(-1)!.status).toBe('client');
    expect(out.rows).toEqual([{ user_id: OWNER_ID, details: { source: 'mcp', contact_id: contactA, from: 'new_lead', to: 'client' }, ip_address: '203.0.113.7' }]);
  });

  it('refuses a stale read with the stored stage, and an unchanged move, writing nothing; each refusal is audited by outcome', async () => {
    const out = await asServerTx(async (tx) => {
      const stale = await move(tx, contactA, 'client', 'cold');
      const unchanged = await move(tx, contactA, 'new_lead', 'new_lead');
      const row = (await tx.query(`SELECT status FROM public.contacts WHERE id = $1`, [contactA])).rows[0];
      return { stale, unchanged, row, rows: (await auditRows(tx, 'mcp_set_contact_status')).map((r) => r.details) };
    });
    expect(out.stale).toEqual({ outcome: 'stale', current_status: 'new_lead' });
    expect(out.unchanged).toEqual({ outcome: 'unchanged', status: 'new_lead' });
    expect(out.row).toEqual({ status: 'new_lead' });
    expect(out.rows).toEqual([
      { source: 'mcp', contact_id: contactA, outcome: 'stale' },
      { source: 'mcp', contact_id: contactA, outcome: 'unchanged' },
    ]);
  });

  it('never moves a contact into the system status, nor out of it', async () => {
    const out = await asServerTx(async (tx) => {
      const into = await attempt(tx, () => move(tx, contactA, 'esign_signer', 'new_lead'));
      await asSetup(tx, `UPDATE public.contacts SET status = 'esign_signer' WHERE id = $1`, [contactB]);
      const outOf = await move(tx, contactB, 'client', 'esign_signer');
      const row = (await tx.query(`SELECT status FROM public.contacts WHERE id = $1`, [contactB])).rows[0];
      return { into, outOf, row };
    });
    expect(out.into).toMatch(/invalid_status/);
    expect(out.outOf).toEqual({ outcome: 'system_status', current_status: 'esign_signer' });
    expect(out.row).toEqual({ status: 'esign_signer' });
  });

  it('refuses an archived contact, and is not_found (unaudited) for a missing one', async () => {
    const out = await asServerTx(async (tx) => {
      await asSetup(tx, `UPDATE public.contacts SET archived_at = now() WHERE id = $1`, [contactB]);
      const archived = await move(tx, contactB, 'client', 'new_lead');
      const missing = await move(tx, randomUUID(), 'client', 'new_lead');
      return { archived, missing, row: (await tx.query(`SELECT status FROM public.contacts WHERE id = $1`, [contactB])).rows[0], rows: (await auditRows(tx, 'mcp_set_contact_status')).map((r) => r.details) };
    });
    expect(out.archived).toEqual({ outcome: 'archived' });
    expect(out.missing).toEqual({ outcome: 'not_found' });
    expect(out.row).toEqual({ status: 'new_lead' });
    expect(out.rows).toEqual([{ source: 'mcp', contact_id: contactB, outcome: 'archived' }]);
  });
});

describe('the board functions', () => {
  /** A card, seeded as the superuser: a lane, a place in it and an archive stamp as given. */
  async function card(tx: Tx, fields: Record<string, unknown> = {}): Promise<string> {
    const row = { title: 'Call back', stage: 'todo', ...fields };
    const cols = Object.keys(row);
    const rows = await asSetup(tx, `INSERT INTO public.work_items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row));
    return rows[0].id as string;
  }
  const events = async (tx: Tx, id: string) =>
    (await tx.query<{ event_type: string; from_value: string | null; to_value: string | null; actor_user_id: string; detail: Record<string, unknown> | null }>(
      `SELECT event_type, from_value, to_value, actor_user_id, detail FROM public.work_item_events WHERE work_item_id = $1 ORDER BY created_at`, [id])).rows;

  it('lists unarchived cards lane by lane in board order, with the lanes and their labels, and says when it is cut short', async () => {
    const out = await asServerTx(async (tx) => {
      const placed = await card(tx, { title: 'Placed', lane_position: 0, created_at: new Date(Date.now() - 60_000).toISOString() });
      const fresh = await card(tx, { title: 'Fresh', contact_id: contactA });
      const doing = await card(tx, { title: 'Doing', stage: 'doing' });
      await card(tx, { title: 'Archived', archived_at: new Date().toISOString() });
      const list = (stage: string | null, contact: string | null, limit = 200) =>
        call<{ lanes: Array<{ key: string; label: string }>; cards: Array<{ id: string; lane: string; contact_name: string | null }>; truncated: boolean }>(
          tx, 'mcp_list_board', { p_stage: stage, p_contact_id: contact, p_limit: limit, ...audit });
      return {
        ids: { placed, fresh, doing },
        all: await list(null, null),
        lane: await list('doing', null),
        mine: await list(null, contactA),
        cut: await list(null, null, 1),
        unknown: await attempt(tx, () => list('made_up', null)),
        rows: (await auditRows(tx, 'mcp_list_board')).map((r) => r.details),
      };
    });
    // An unplaced card sorts above a placed one in its lane; lanes run in their order.
    expect(out.all.cards.map((c) => c.id)).toEqual([out.ids.fresh, out.ids.placed, out.ids.doing]);
    expect(out.all.cards[2].lane).toBe('In progress');
    expect(out.all.lanes.map((l) => l.key)).toEqual(['todo', 'waiting', 'doing', 'done']);
    expect(out.all.truncated).toBe(false);
    expect(out.all.cards[0].contact_name).toBe('Ada Lovelace');
    expect(out.lane.cards.map((c) => c.id)).toEqual([out.ids.doing]);
    expect(out.mine.cards.map((c) => c.id)).toEqual([out.ids.fresh]);
    expect(out.cut).toMatchObject({ truncated: true });
    expect(out.cut.cards).toHaveLength(1);
    expect(out.unknown).toMatch(/unknown_stage/);
    expect(out.rows[0]).toEqual({ source: 'mcp', stage: null, contact_id: null, returned: 3, truncated: false });
  });

  it('creates a card with the column defaults and a created event by the actor, audited', async () => {
    const out = await asServerTx(async (tx) => {
      const created = await call<Record<string, unknown>>(tx, 'mcp_create_work_item', {
        p_title: '  Send the proposal ', p_contact_id: contactA, p_work_item_type: null, p_stage: null, p_priority: null, p_due_date: '2027-04-15', ...audit,
      });
      return { created, ev: await events(tx, created.id as string), rows: (await auditRows(tx, 'mcp_create_work_item')).map((r) => r.details) };
    });
    expect(out.created).toMatchObject({ title: 'Send the proposal', contact_id: contactA, work_item_type: 'task', stage: 'todo', priority: 'normal', due_date: '2027-04-15' });
    expect(out.ev).toEqual([{ event_type: 'created', from_value: null, to_value: 'todo', actor_user_id: OWNER_ID, detail: { source: 'mcp' } }]);
    expect(out.rows).toEqual([{ source: 'mcp', work_item_id: out.created.id, contact_id: contactA, stage: 'todo' }]);
  });

  it.each([
    ['a missing contact', async () => ({ p_contact_id: randomUUID() }), /contact_not_found/],
    ['an archived contact', async (tx: Tx) => {
      await asSetup(tx, `UPDATE public.contacts SET archived_at = now() WHERE id = $1`, [contactB]);
      return { p_contact_id: contactB };
    }, /contact_archived/],
    ['a retired card type', async (tx: Tx) => {
      await asSetup(tx, `UPDATE public.work_item_types SET is_active = false WHERE key = 'call'`);
      return { p_work_item_type: 'call' };
    }, /inactive_type/],
  ])('refuses to create a card for %s, writing nothing', async (_label, setup, error) => {
    const out = await asServerTx(async (tx) => {
      const over = await setup(tx);
      const err = await attempt(tx, () => call(tx, 'mcp_create_work_item', {
        p_title: 'T', p_contact_id: null, p_work_item_type: null, p_stage: null, p_priority: null, p_due_date: null, ...audit, ...over,
      }));
      return { err, n: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.work_items`)).rows[0].n };
    });
    expect(out.err).toMatch(error);
    expect(out.n).toBe(0);
  });

  it('edits only the keys present: null clears the contact and the date, an absent key is kept; not_found for a missing card', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await card(tx, { contact_id: contactA, due_date: '2027-01-01', priority: 'urgent' });
      const edited = await call<Record<string, unknown>>(tx, 'mcp_update_work_item', { p_id: id, p_patch: { contact_id: null, due_date: null, title: ' Renamed ' }, ...audit });
      const missing = await call(tx, 'mcp_update_work_item', { p_id: randomUUID(), p_patch: { title: 'x' }, ...audit });
      await asSetup(tx, `UPDATE public.contacts SET archived_at = now() WHERE id = $1`, [contactB]);
      const toArchived = await attempt(tx, () => call(tx, 'mcp_update_work_item', { p_id: id, p_patch: { contact_id: contactB }, ...audit }));
      return { edited, missing, toArchived, rows: (await auditRows(tx, 'mcp_update_work_item')).map((r) => r.details) };
    });
    expect(out.edited).toMatchObject({ outcome: 'updated', card: { title: 'Renamed', contact_id: null, due_date: null, priority: 'urgent', stage: 'todo' } });
    expect(out.missing).toEqual({ outcome: 'not_found' });
    expect(out.toArchived).toMatch(/contact_archived/);
    expect(out.rows).toEqual([{ source: 'mcp', work_item_id: expect.any(String), fields: ['contact_id', 'due_date', 'title'] }]);
  });

  it('moves a card on a matching read, clearing its place in the lane and recording the reason by the actor', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await card(tx, { lane_position: 3 });
      const moved = await call(tx, 'mcp_move_work_item', { p_id: id, p_stage: 'doing', p_expected_stage: 'todo', p_note: ' Started ', ...audit });
      const row = (await tx.query(`SELECT stage, lane_position FROM public.work_items WHERE id = $1`, [id])).rows[0];
      return { moved, row, ev: await events(tx, id), rows: (await auditRows(tx, 'mcp_move_work_item')).map((r) => r.details) };
    });
    expect(out.moved).toEqual({ outcome: 'moved', from: 'todo', stage: 'doing' });
    expect(out.row).toEqual({ stage: 'doing', lane_position: null });
    expect(out.ev).toEqual([{ event_type: 'stage_changed', from_value: 'todo', to_value: 'doing', actor_user_id: OWNER_ID, detail: { note: 'Started', source: 'mcp' } }]);
    expect(out.rows).toEqual([{ source: 'mcp', work_item_id: expect.any(String), from: 'todo', to: 'doing' }]);
  });

  it('refuses a stale read, an unchanged move and an archived card, moving nothing and writing no history', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await card(tx, { stage: 'waiting' });
      const archived = await card(tx, { archived_at: new Date().toISOString() });
      const mv = (cardId: string, stage: string, expected: string) =>
        call(tx, 'mcp_move_work_item', { p_id: cardId, p_stage: stage, p_expected_stage: expected, p_note: 'r', ...audit });
      return {
        stale: await mv(id, 'doing', 'todo'),
        unchanged: await mv(id, 'waiting', 'waiting'),
        off: await mv(archived, 'doing', 'todo'),
        missing: await mv(randomUUID(), 'doing', 'todo'),
        noNote: await attempt(tx, () => call(tx, 'mcp_move_work_item', { p_id: id, p_stage: 'doing', p_expected_stage: 'waiting', p_note: '  ', ...audit })),
        stages: (await tx.query(`SELECT stage FROM public.work_items ORDER BY stage`)).rows,
        ev: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.work_item_events`)).rows[0].n,
      };
    });
    expect(out.stale).toEqual({ outcome: 'stale', current_stage: 'waiting' });
    expect(out.unchanged).toEqual({ outcome: 'unchanged', stage: 'waiting' });
    expect(out.off).toEqual({ outcome: 'not_on_board' });
    expect(out.missing).toEqual({ outcome: 'not_found' });
    expect(out.noNote).toMatch(/note_required/);
    expect(out.stages).toEqual([{ stage: 'todo' }, { stage: 'waiting' }]);
    expect(out.ev).toBe(0);
  });

  it('notes a card without moving it; not_found for a missing card; a blank note is refused', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await card(tx);
      const note = (cardId: string, text: string) => call(tx, 'mcp_add_work_item_note', { p_id: cardId, p_note: text, ...audit });
      return {
        ok: await note(id, ' Left a message '),
        missing: await note(randomUUID(), 'x'),
        blank: await attempt(tx, () => note(id, ' ')),
        ev: await events(tx, id),
        rows: (await auditRows(tx, 'mcp_add_work_item_note')).map((r) => r.details),
      };
    });
    expect(out.ok).toEqual({ outcome: 'noted' });
    expect(out.missing).toEqual({ outcome: 'not_found' });
    expect(out.blank).toMatch(/note_required/);
    expect(out.ev).toEqual([{ event_type: 'note_added', from_value: null, to_value: null, actor_user_id: OWNER_ID, detail: { note: 'Left a message', source: 'mcp' } }]);
    expect(out.rows).toEqual([{ source: 'mcp', work_item_id: expect.any(String) }]);
  });
});

describe('the request follow-up functions', () => {
  /** A request in a given status with items in given statuses, seeded as the superuser. */
  async function request(tx: Tx, status: string, items: Array<{ kind?: string; status: string }> = [], contact = contactA, title = 'Onboarding'): Promise<string> {
    const [{ id }] = await asSetup(tx, `INSERT INTO public.needs_lists (contact_id, title, status) VALUES ($1, $2, $3) RETURNING id`, [contact, title, status]);
    for (const [i, it] of items.entries()) {
      await asSetup(tx, `INSERT INTO public.needs_items (list_id, kind, label, status, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [id, it.kind ?? 'todo', `Item ${i + 1}`, it.status, i]);
    }
    return id as string;
  }
  const close = (tx: Tx, list: string, contact = contactA) =>
    call<Record<string, unknown>>(tx, 'mcp_close_request', { p_list_id: list, p_contact_id: contact, ...audit });
  const accept = (tx: Tx, list: string, contact = contactA) =>
    call<Record<string, unknown> | null>(tx, 'mcp_accept_request', { p_list_id: list, p_contact_id: contact, ...audit });

  it('closes a sent or a submitted request, stamping closed_at, audited with where it came from', async () => {
    const out = await asServerTx(async (tx) => {
      const sent = await request(tx, 'sent');
      const submitted = await request(tx, 'submitted');
      return {
        sent: await close(tx, sent),
        submitted: await close(tx, submitted),
        rows: await tx.query(`SELECT status, closed_at IS NOT NULL AS stamped FROM public.needs_lists WHERE id = ANY($1)`, [[sent, submitted]]),
        audit: (await auditRows(tx, 'mcp_close_request')).map((r) => r.details.from_status),
      };
    });
    expect(out.sent).toEqual({ applied: true, from_status: 'sent' });
    expect(out.submitted).toEqual({ applied: true, from_status: 'submitted' });
    expect(out.rows.rows).toEqual([{ status: 'closed', stamped: true }, { status: 'closed', stamped: true }]);
    expect(out.audit).toEqual(['sent', 'submitted']);
  });

  it('never closes a draft; closing again changes nothing; another contact’s request is not_found and unaudited', async () => {
    const out = await asServerTx(async (tx) => {
      const draft = await request(tx, 'draft');
      const closed = await request(tx, 'closed');
      const other = await request(tx, 'sent', [], contactB);
      return {
        draft: await close(tx, draft),
        again: await close(tx, closed),
        other: await close(tx, other, contactA),
        statuses: (await tx.query<{ status: string }>(`SELECT status FROM public.needs_lists WHERE id = ANY($1)`, [[draft, other]])).rows,
        audit: (await auditRows(tx, 'mcp_close_request')).map((r) => r.details.outcome),
      };
    });
    expect(out.draft).toEqual({ applied: false, reason: 'draft' });
    expect(out.again).toEqual({ applied: false, reason: 'already_closed' });
    expect(out.other).toEqual({ applied: false, reason: 'not_found' });
    expect(out.statuses.map((r) => r.status).sort()).toEqual(['draft', 'sent']);
    expect(out.audit).toEqual(['draft', 'already_closed']);
  });

  it('accepting the last outstanding answer closes the request through 0014’s trigger, and the result says closed', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'fulfilled' }, { status: 'reviewed' }, { kind: 'info', status: 'pending' }]);
      return {
        result: await accept(tx, id),
        stored: (await tx.query(`SELECT status, closed_at IS NOT NULL AS stamped FROM public.needs_lists WHERE id = $1`, [id])).rows[0],
      };
    });
    expect(out.result).toEqual({ accepted: 1, still_open: 0, list_status: 'closed' });
    expect(out.stored).toEqual({ status: 'closed', stamped: true });
  });

  it('a sent request that still asks the client to confirm their details stays sent when its last answer is accepted', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'fulfilled' }]);
      await asSetup(tx, `UPDATE public.needs_lists SET include_contact_confirm = true WHERE id = $1`, [id]);
      return { result: await accept(tx, id), stored: (await tx.query(`SELECT status FROM public.needs_lists WHERE id = $1`, [id])).rows[0] };
    });
    expect(out.result).toEqual({ accepted: 1, still_open: 0, list_status: 'sent' });
    expect(out.stored).toEqual({ status: 'sent' });
  });

  it('accepts only the answered items, counts what is still open (not the read-only ones), and leaves the request open', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'fulfilled' }, { status: 'fulfilled' }, { status: 'pending' }, { status: 'reviewed' }, { kind: 'info', status: 'pending' }]);
      const version = await versionOf(tx, id);
      const result = await accept(tx, id);
      return {
        result,
        items: (await tx.query<{ status: string }>(`SELECT status FROM public.needs_items WHERE list_id = $1 ORDER BY sort_order`, [id])).rows.map((r) => r.status),
        list: (await tx.query(`SELECT status FROM public.needs_lists WHERE id = $1`, [id])).rows[0],
        versionMoved: (await versionOf(tx, id)) !== version,
        again: await accept(tx, id),
        audit: (await auditRows(tx, 'mcp_accept_request')).map((r) => r.details.accepted),
      };
    });
    expect(out.result).toEqual({ accepted: 2, still_open: 1, list_status: 'sent' });
    expect(out.items).toEqual(['reviewed', 'reviewed', 'pending', 'reviewed', 'pending']);
    expect(out.list).toEqual({ status: 'sent' });
    expect(out.versionMoved).toBe(false);
    expect(out.again).toEqual({ accepted: 0, still_open: 1, list_status: 'sent' });
    expect(out.audit).toEqual([2, 0]);
  });

  it('accept is NULL for another contact’s request, accepting nothing', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'fulfilled' }], contactB);
      return { result: await accept(tx, id, contactA), items: (await tx.query(`SELECT status FROM public.needs_items WHERE list_id = $1`, [id])).rows };
    });
    expect(out.result).toBeNull();
    expect(out.items).toEqual([{ status: 'fulfilled' }]);
  });

  it('pauses and resumes reminders on the named contact’s request only, leaving the content version alone', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'pending' }]);
      const version = await versionOf(tx, id);
      const set = (paused: boolean, contact = contactA) =>
        call(tx, 'mcp_set_request_reminders', { p_list_id: id, p_contact_id: contact, p_paused: paused, ...audit });
      const paused = await set(true);
      const wrong = await set(false, contactB);
      const stored = (await tx.query(`SELECT reminders_paused FROM public.needs_lists WHERE id = $1`, [id])).rows[0];
      return { paused, wrong, stored, sameVersion: (await versionOf(tx, id)) === version, nullPaused: await attempt(tx, () => call(tx, 'mcp_set_request_reminders', { p_list_id: id, p_contact_id: contactA, p_paused: null, ...audit })), audit: (await auditRows(tx, 'mcp_set_request_reminders')).map((r) => r.details.paused) };
    });
    expect(out.paused).toEqual({ id: expect.any(String), title: 'Onboarding', status: 'sent', reminders_paused: true });
    expect(out.wrong).toBeNull();
    expect(out.stored).toEqual({ reminders_paused: true });
    expect(out.sameVersion).toBe(true);
    expect(out.nullPaused).toMatch(/paused_required/);
    expect(out.audit).toEqual([true]);
  });

  it('the roster reads every open request with its items’ kinds and statuses, clients A to Z, never a closed one or an answer', async () => {
    const out = await asServerTx(async (tx) => {
      const submitted = await request(tx, 'submitted', [], contactB, 'Year end');
      const toAccept = await request(tx, 'sent', [{ status: 'fulfilled' }, { status: 'pending' }], contactA, 'Kickoff');
      const waiting = await request(tx, 'sent', [{ status: 'pending' }], contactA, 'Follow up');
      const draft = await request(tx, 'draft', [], contactA, 'Next');
      await request(tx, 'closed', [], contactA, 'Old');
      // One transaction shares one now(): spread the creation times so newest first is decided.
      for (const [id, ago] of [[toAccept, 3], [waiting, 2], [draft, 1]] as const) {
        await asSetup(tx, `UPDATE public.needs_lists SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, ago]);
      }
      const read = (limit = 500) => call<{ rows: Array<Record<string, unknown>>; truncated: boolean }>(tx, 'mcp_list_open_requests', { p_limit: limit, ...audit });
      return { ids: { submitted, toAccept, waiting, draft }, all: await read(), cut: await read(1), audit: (await auditRows(tx, 'mcp_list_open_requests')).map((r) => r.details) };
    });
    const rows = out.all.rows;
    // Clients A to Z, then newest first: no sections here (mcp-crm groups through the shared roster).
    expect(rows.map((r) => r.list_id)).toEqual([out.ids.draft, out.ids.waiting, out.ids.toAccept, out.ids.submitted]);
    expect(rows.find((r) => r.list_id === out.ids.toAccept)).toMatchObject({
      client: 'Ada Lovelace', title: 'Kickoff', status: 'sent', items: [{ kind: 'todo', status: 'fulfilled' }, { kind: 'todo', status: 'pending' }],
    });
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        'client', 'contact_id', 'created_at', 'items', 'list_id', 'reminder_count', 'reminders_paused', 'sent_at', 'status', 'submitted_at', 'title',
      ]);
    }
    expect(out.all.truncated).toBe(false);
    expect(out.cut.rows).toHaveLength(1);
    expect(out.cut.truncated).toBe(true);
    expect(out.audit).toEqual([{ source: 'mcp', returned: 4, truncated: false }, { source: 'mcp', returned: 1, truncated: true }]);
  });

  it('a request write whose audit row cannot be written does not happen, and says so with the fixed sentinel', async () => {
    const out = await asServerTx(async (tx) => {
      const id = await request(tx, 'sent', [{ status: 'fulfilled' }]);
      const noActor = { p_actor: null, p_ip: null, p_user_agent: null };
      return {
        close: await attempt(tx, () => call(tx, 'mcp_close_request', { p_list_id: id, p_contact_id: contactA, ...noActor })),
        accept: await attempt(tx, () => call(tx, 'mcp_accept_request', { p_list_id: id, p_contact_id: contactA, ...noActor })),
        pause: await attempt(tx, () => call(tx, 'mcp_set_request_reminders', { p_list_id: id, p_contact_id: contactA, p_paused: true, ...noActor })),
        list: (await tx.query(`SELECT status, reminders_paused FROM public.needs_lists WHERE id = $1`, [id])).rows[0],
        items: (await tx.query(`SELECT status FROM public.needs_items WHERE list_id = $1`, [id])).rows,
      };
    });
    for (const err of [out.close, out.accept, out.pause]) expect(err).toBe('mcp_request_audit: failed');
    expect(out.list).toEqual({ status: 'sent', reminders_paused: false });
    expect(out.items).toEqual([{ status: 'fulfilled' }]);
  });
});

describe('archived cards are off the board for every board write', () => {
  it('an archived card is neither edited nor noted: not_on_board, nothing written, the refusal audited', async () => {
    const out = await asServerTx(async (tx) => {
      const [{ id }] = await asSetup(tx, `INSERT INTO public.work_items (title, archived_at) VALUES ('Old', now()) RETURNING id`);
      const edit = await call(tx, 'mcp_update_work_item', { p_id: id, p_patch: { title: 'New' }, ...audit });
      const note = await call(tx, 'mcp_add_work_item_note', { p_id: id, p_note: 'x', ...audit });
      return {
        edit, note,
        row: (await tx.query(`SELECT title FROM public.work_items WHERE id = $1`, [id])).rows[0],
        events: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.work_item_events WHERE work_item_id = $1`, [id])).rows[0].n,
        rows: [...await auditRows(tx, 'mcp_update_work_item'), ...await auditRows(tx, 'mcp_add_work_item_note')].map((r) => r.details.outcome),
      };
    });
    expect(out.edit).toEqual({ outcome: 'not_on_board' });
    expect(out.note).toEqual({ outcome: 'not_on_board' });
    expect(out.row).toEqual({ title: 'Old' });
    expect(out.events).toBe(0);
    expect(out.rows).toEqual(['not_on_board', 'not_on_board']);
  });
});

describe('the consent version', () => {
  const rotate = (tx: Tx, old: string, next: string) =>
    call<{ status: string }>(tx, 'mcp_oauth_rotate_refresh', {
      p_old_hash: old, p_client_id: CLIENT_ID, p_access_hash: `a-${next}`, p_access_expires: later(600_000), p_refresh_hash: next,
      p_refresh_idle_expires: later(7 * 86_400_000), p_ip: null, p_user_agent: null,
    });

  it('a new grant carries the current version; one approved on older wording authenticates, refreshes and lists as nothing', async () => {
    const out = await asServerTx(async (tx) => {
      const current = await call<number>(tx, 'mcp_consent_version');
      const fresh = await seedGrant(tx, { access: 'new-access', refresh: 'new-refresh' });
      const old = await seedGrant(tx, { access: 'old-access', refresh: 'old-refresh' });
      await asSetup(tx, `UPDATE public.mcp_oauth_grants SET consent_version = consent_version - 1 WHERE id = $1`, [old]);
      const versions = (await tx.query<{ id: string; v: number }>(`SELECT id, consent_version AS v FROM public.mcp_oauth_grants`)).rows;
      const result = {
        current,
        freshVersion: versions.find((r) => r.id === fresh)!.v,
        freshAuth: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'new-access' }),
        oldAuth: await call(tx, 'mcp_oauth_authenticate', { p_access_hash: 'old-access' }),
        oldRefresh: await rotate(tx, 'old-refresh', 'old-next'),
        freshRefresh: await rotate(tx, 'new-refresh', 'new-next'),
      };
      await become(tx, asOwner);
      const listed = await call<Array<{ id: string }>>(tx, 'mcp_list_grants');
      return { ...result, listed: listed.map((g) => g.id), fresh, old };
    });
    expect(out.current).toBe(2);
    expect(out.freshVersion).toBe(out.current);
    expect(out.freshAuth).toMatchObject({ grant_id: out.fresh });
    expect(out.oldAuth).toBeNull();
    expect(out.oldRefresh).toEqual({ status: 'invalid' });
    expect(out.freshRefresh).toMatchObject({ status: 'ok' });
    expect(out.listed).toContain(out.fresh);
    expect(out.listed).not.toContain(out.old);
  });

  it('a grant that existed before this migration is version 1, so its approver must consent again', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'public.mcp_oauth_grants'::regclass AND a.attname = 'consent_version'`);
    // The column was added with DEFAULT 1 (filling the rows already there), then the default
    // was dropped, so every grant written after states its version; the source says so in
    // that order, and the catalog holds no default.
    expect(rows).toEqual([]);
    const sql = (await import('node:fs')).readFileSync('supabase/migrations/0015_mcp.sql', 'utf8');
    const add = sql.indexOf('ADD COLUMN consent_version integer NOT NULL DEFAULT 1;');
    const drop = sql.indexOf('ALTER COLUMN consent_version DROP DEFAULT;');
    expect(add).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(add);
  });
});
