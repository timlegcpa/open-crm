// @vitest-environment node
// mfa-recovery against the real migrations in PGlite: the claim, release, stamp, lockout
// and finalize RPCs, the factor-delete trigger, the portal account and impersonation
// rows. Auth (sessions, sign-out, factor deletion) is faked at its boundary: deleting a
// factor deletes its auth.mfa_factors row, as Supabase Auth does.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, OWNER_ID, SYSTEM_ID, seedContact, seedCore, seedPortalAccount } from '../db/harness';
import { serviceClient } from './pgliteClient';
import { CREDENTIALS, describeEdgeContract, edgeRequest, OWNER_TOKEN, throwInternal } from './contract';
import { checkPublicLimits, checkUserLimit } from '../../../supabase/functions/_shared/rate-limit';
import { createBackupCodeHasher, generateBackupCode, normalizeBackupCode } from '../../../supabase/functions/_shared/mfa-backup-code';
import {
  createMfaRecoveryHandler,
  INVALID_CODE,
  recoveryAlerts,
  RETRY_LATER,
  type AlertEmail,
  type MfaRecoveryDeps,
} from '../../../supabase/functions/mfa-recovery/handler';

const SERVICE_KEY = 's'.repeat(64);
const hashCode = createBackupCodeHasher(SERVICE_KEY);
const VALID_CODE = 'ABCDE-FGHJK-MNPQR-STVWX';

function tokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

function fakeDeps(over: Partial<MfaRecoveryDeps> = {}): MfaRecoveryDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: null,
    publicLimits: async () => 'allowed',
    userLimit: async () => 'allowed',
    sessionUserId: async (token) => (token === OWNER_TOKEN ? 'owner-user' : null),
    accountKind: async () => 'owner',
    isViewAsClient: async () => false,
    addresses: async () => ({ account: 'owner@example.com', owner: 'owner@example.com' }),
    hashCode: async () => 'h',
    claim: async () => ({ state: 'claimed', id: 'code-1', lease: 'lease-1', alerted: false }),
    release: async () => {},
    sendEmail: async () => true,
    stampAlert: async () => true,
    renewLease: async () => true,
    signOutEverywhere: async () => {},
    finalize: async () => {},
    sleep: async () => {},
    ...over,
  };
}

describeEdgeContract({
  name: 'mfa-recovery',
  handler: createMfaRecoveryHandler(fakeDeps()),
  failingHandler: createMfaRecoveryHandler(fakeDeps({ accountKind: throwInternal })),
  limitedHandler: createMfaRecoveryHandler(fakeDeps({ publicLimits: async () => 'limited' })),
  credentials: CREDENTIALS.owner,
  body: { kind: 'json', valid: { code: VALID_CODE }, maxBytes: 4000 },
});

describe('the alert', () => {
  const at = new Date('2030-01-02T03:04:05Z');

  it('goes to the owner, never with the account address in the subject', () => {
    const [alert, ...rest] = recoveryAlerts({ kind: 'owner', account: 'owner@example.com', owner: 'owner@example.com', ip: '192.0.2.1', at, codeId: 'c1', siteUrl: 'https://crm.example.com' });
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ to: 'owner@example.com', subject: 'Two-factor removed with a backup code', idempotencyKey: 'mfa-recovery:c1:owner' });
    expect(alert.content.blocks).toContainEqual({ kind: 'button', label: 'Open settings', url: 'https://crm.example.com/settings' });
  });

  it('for a client: the owner hears which account, and the client gets their own copy', () => {
    const alerts = recoveryAlerts({ kind: 'client', account: 'ada@example.com', owner: 'owner@example.com', ip: null, at, codeId: 'c1', siteUrl: 'https://crm.example.com' });
    expect(alerts.map((a) => [a.to, a.idempotencyKey])).toEqual([
      ['owner@example.com', 'mfa-recovery:c1:owner'],
      ['ada@example.com', 'mfa-recovery:c1:account'],
    ]);
    expect(JSON.stringify(alerts[0].content)).toContain('ada@example.com');
    for (const a of alerts) expect(a.subject).not.toContain('@');
    expect(alerts[1].content.blocks).toContainEqual({ kind: 'button', label: 'Open your profile', url: 'https://crm.example.com/portal/profile' });
  });
});

describe('mfa-recovery', () => {
  let db: PGlite;
  let clientUser: string;
  let ownerCodes: string[];
  let clientCodes: string[];
  let events: string[];
  let sent: AlertEmail[];
  let logs: string[];
  const MINTED = randomUUID();

  const tokenFor = (userId: string, sessionId: string | null = randomUUID()) =>
    tokenWith({ sub: userId, aal: 'aal1', iat: Math.floor(Date.now() / 1000), ...(sessionId ? { session_id: sessionId } : {}) });
  const tokens = new Map<string, string>();

  async function issueCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 8 }, generateBackupCode);
    const hashes = await Promise.all(codes.map((c) => hashCode(normalizeBackupCode(c)!)));
    await db.query(`SELECT public.mfa_backup_codes_replace($1, $2, $3, nextval('public.mfa_backup_code_generation_seq'))`, [userId, hashes, randomUUID()]);
    return codes;
  }

  beforeEach(async () => {
    db = await createDb();
    await seedCore(db);
    const contactId = await seedContact(db, { email: 'ada@example.com' });
    clientUser = (await seedPortalAccount(db, contactId, { email: 'ada@example.com' })).userId;
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified'), ($2, 'verified')`, [OWNER_ID, clientUser]);
    ownerCodes = await issueCodes(OWNER_ID);
    clientCodes = await issueCodes(clientUser);
    events = [];
    sent = [];
    logs = [];
    tokens.clear();
  }, 60_000);

  function dbDeps(over: Partial<MfaRecoveryDeps> = {}): MfaRecoveryDeps {
    const server = serviceClient(db);
    const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await server.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    };
    const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
    return {
      allowedOrigins: ['http://localhost:5173'],
      siteUrl: 'https://crm.example.com',
      publicLimits: async () => 'allowed',
      userLimit: (userId) => checkUserLimit(server, { action: 'mfa_recovery', userId, max: 5, windowMinutes: 15 }),
      sessionUserId: async (token) => tokens.get(token) ?? null,
      async accountKind(userId) {
        const org = await one<{ owner_user_id: string; system_user_id: string }>('SELECT owner_user_id, system_user_id FROM public.org_profile');
        if (org.system_user_id === userId) return null;
        if (org.owner_user_id === userId) return 'owner';
        const acct = await one(`SELECT 1 FROM public.client_portal_accounts WHERE user_id = $1 AND status = 'active'`, [userId]);
        return acct ? 'client' : null;
      },
      isViewAsClient: async (userId, sessionId) => (await rpc('is_impersonation_session', { p_user: userId, p_session: sessionId })) !== false,
      async addresses(userId) {
        const email = async (id: string) => (await one<{ email: string }>('SELECT email FROM auth.users WHERE id = $1', [id]))?.email ?? null;
        return { account: await email(userId), owner: await email(OWNER_ID) };
      },
      hashCode,
      claim: async (userId, hash) => (await rpc('mfa_backup_code_claim', { p_user_id: userId, p_hash: hash })) as never,
      release: async (id, userId, lease) => void (await rpc('mfa_backup_code_release', { p_id: id, p_user_id: userId, p_lease: lease })),
      async sendEmail(message) {
        events.push(`email:${message.idempotencyKey}`);
        sent.push(message);
        return true;
      },
      async stampAlert(id, userId, lease) {
        events.push('stamp');
        return (await rpc('mfa_backup_code_alerted', { p_id: id, p_user_id: userId, p_lease: lease })) === true;
      },
      async renewLease(id, userId, lease) {
        events.push('renew');
        return (await rpc('mfa_backup_code_lease_renew', { p_id: id, p_user_id: userId, p_lease: lease })) === true;
      },
      signOutEverywhere: async () => void events.push('sign-out'),
      async finalize(id, userId, lease, ip, ua) {
        events.push('finalize');
        await rpc('mfa_backup_code_finalize', { p_id: id, p_user_id: userId, p_lease: lease, p_ip: ip, p_user_agent: ua });
      },
      sleep: async () => {},
      logSink: (_level, line) => logs.push(line),
      ...over,
    };
  }

  function redeem(deps: MfaRecoveryDeps, userId: string, code: unknown, sessionId?: string | null) {
    const token = tokenFor(userId, sessionId);
    tokens.set(token, userId);
    return createMfaRecoveryHandler(deps)(edgeRequest({ headers: { Authorization: `Bearer ${token}` }, body: { code } }));
  }

  const factors = async (userId: string) =>
    (await db.query(`SELECT 1 FROM auth.mfa_factors WHERE user_id = $1 AND status = 'verified'`, [userId])).rows.length;
  const statuses = async (userId: string) =>
    (await db.query<{ status: string }>('SELECT status FROM public.mfa_backup_codes WHERE user_id = $1 ORDER BY status', [userId])).rows.map((r) => r.status);

  it('the owner redeems a code: alert, stamp, renew, sign-out, then lockout, factors removed, code used, rest revoked, audited', async () => {
    const res = await redeem(dbDeps(), OWNER_ID, ownerCodes[3].toLowerCase());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { note: string }).note).toContain('from Settings');
    expect(events[0]).toMatch(/^email:mfa-recovery:[0-9a-f-]{36}:owner$/);
    expect(events.slice(1)).toEqual(['stamp', 'renew', 'sign-out', 'finalize']);
    expect(await factors(OWNER_ID)).toBe(0);
    expect(await statuses(OWNER_ID)).toEqual([...Array(7).fill('revoked'), 'used']);
    expect((await db.query('SELECT 1 FROM public.mfa_recovery_lockouts WHERE user_id = $1', [OWNER_ID])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM public.audit_logs WHERE action = 'mfa_recovery_used' AND user_id = $1`, [OWNER_ID])).rows).toHaveLength(1);
    // The client's account is untouched.
    expect(await factors(clientUser)).toBe(1);
    expect(sent.map((s) => s.to)).toEqual(['owner@example.test']);
  });

  it('a client redeems their own code: the owner is alerted and the client gets a copy', async () => {
    const res = await redeem(dbDeps(), clientUser, clientCodes[0]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { note: string }).note).toContain('your profile');
    expect(sent.map((s) => s.to)).toEqual(['owner@example.test', 'ada@example.com']);
    expect(await factors(clientUser)).toBe(0);
    expect(await factors(OWNER_ID)).toBe(1);
  });

  it("another account's code is just a wrong code", async () => {
    const res = await redeem(dbDeps(), clientUser, ownerCodes[0]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVALID_CODE, code: 'invalid_code' });
    expect(sent).toEqual([]);
    expect(await factors(OWNER_ID)).toBe(1);
  });

  it('every wrong code gets the same answer, and changes nothing', async () => {
    for (const code of ['ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'nope', '', 42, null]) {
      const res = await redeem(dbDeps(), OWNER_ID, code);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: INVALID_CODE, code: 'invalid_code' });
    }
    expect(events).toEqual([]);
    expect(await statuses(OWNER_ID)).toEqual(Array(8).fill('active'));
  });

  it('a used code cannot be used again', async () => {
    await redeem(dbDeps(), OWNER_ID, ownerCodes[0]);
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER_ID]);
    const res = await redeem(dbDeps(), OWNER_ID, ownerCodes[0]);
    expect(res.status).toBe(400);
  });

  it('alert before strip: a failed alert releases the code and removes nothing', async () => {
    for (const sendEmail of [async () => false, async () => { throw new Error('provider down'); }]) {
      const res = await redeem(dbDeps({ sendEmail }), OWNER_ID, ownerCodes[0]);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: RETRY_LATER, code: 'retry' });
      expect(await factors(OWNER_ID)).toBe(1);
      expect(await statuses(OWNER_ID)).toEqual(Array(8).fill('active'));
    }
    expect(events).toEqual([]);
  });

  it('a lost alert stamp releases the code and removes nothing', async () => {
    const res = await redeem(dbDeps({ stampAlert: async () => false }), OWNER_ID, ownerCodes[0]);
    expect(res.status).toBe(502);
    expect(await statuses(OWNER_ID)).toEqual(Array(8).fill('active'));
    expect(await factors(OWNER_ID)).toBe(1);
  });

  it('a failed sign-out stops before any factor dies; the same code resumes without a second alert', async () => {
    const signOutEverywhere = vi.fn(async () => { throw new Error('auth down'); });
    const first = await redeem(dbDeps({ signOutEverywhere }), OWNER_ID, ownerCodes[0]);
    expect(first.status).toBe(502);
    expect(signOutEverywhere).toHaveBeenCalledTimes(3);
    expect(await factors(OWNER_ID)).toBe(1);
    expect(sent).toHaveLength(1);

    const second = await redeem(dbDeps(), OWNER_ID, ownerCodes[0]);
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(await factors(OWNER_ID)).toBe(0);
  });

  it('a failed finalize removes nothing, and the same code resumes at once', async () => {
    const res = await redeem(dbDeps({ finalize: async () => { throw new Error('db'); } }), OWNER_ID, ownerCodes[0]);
    expect(res.status).toBe(502);
    expect(await factors(OWNER_ID)).toBe(1);
    expect((await redeem(dbDeps(), OWNER_ID, ownerCodes[0])).status).toBe(200);
    expect(await factors(OWNER_ID)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  describe('one request at a time', () => {
    const codeRow = async (code: string) =>
      (await db.query<{ id: string; status: string; lease_token: string | null }>(
        'SELECT id, status, lease_token FROM public.mfa_backup_codes WHERE code_hash = $1',
        [await hashCode(normalizeBackupCode(code)!)],
      )).rows[0];
    const claimRpc = async (userId: string, code: string) =>
      (await db.query<{ r: { state: string; id?: string; lease?: string } }>('SELECT public.mfa_backup_code_claim($1, $2) AS r', [
        userId,
        await hashCode(normalizeBackupCode(code)!),
      ])).rows[0].r;
    const finalizeRpc = (id: string, lease: string) =>
      db.query('SELECT public.mfa_backup_code_finalize($1, $2, $3, NULL, NULL)', [id, OWNER_ID, lease]);
    const alertedRpc = async (id: string, lease: string) =>
      (await db.query<{ ok: boolean }>('SELECT public.mfa_backup_code_alerted($1, $2, $3) AS ok', [id, OWNER_ID, lease])).rows[0].ok;

    it('a second resume of the same alerted code while the first holds it is in flight, not a second resumer', async () => {
      const first = await claimRpc(OWNER_ID, ownerCodes[0]);
      expect(first.state).toBe('claimed');
      expect(await alertedRpc(first.id!, first.lease!)).toBe(true);
      expect((await claimRpc(OWNER_ID, ownerCodes[0])).state).toBe('in_flight');
      // Through the handler too: answered "try again", and nothing is touched.
      const res = await redeem(dbDeps(), OWNER_ID, ownerCodes[0]);
      expect(res.status).toBe(409);
      expect(events).toEqual([]);
      expect(await factors(OWNER_ID)).toBe(1);
    });

    it('a delayed request whose lease was taken over deletes nothing, not even a factor enrolled after the takeover finished', async () => {
      // Request A claims and alerts, then stalls past its lease.
      const a = await claimRpc(OWNER_ID, ownerCodes[0]);
      expect(await alertedRpc(a.id!, a.lease!)).toBe(true);
      await db.query(`UPDATE public.mfa_backup_codes SET lease_until = now() - interval '1 second' WHERE id = $1`, [a.id]);

      // Request B resumes with a new lease and finishes the recovery.
      const b = await claimRpc(OWNER_ID, ownerCodes[0]);
      expect(b.state).toBe('resume');
      expect(b.lease).not.toBe(a.lease);
      await finalizeRpc(b.id!, b.lease!);
      expect(await factors(OWNER_ID)).toBe(0);

      // The owner signs in again and enrols a new authenticator.
      await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [OWNER_ID]);

      // A wakes up: every step it could still take refuses, and the new factor survives.
      await expect(finalizeRpc(a.id!, a.lease!)).rejects.toThrow(/lease_lost/);
      expect((await db.query<{ ok: boolean }>('SELECT public.mfa_backup_code_lease_renew($1, $2, $3) AS ok', [a.id, OWNER_ID, a.lease])).rows[0].ok).toBe(false);
      expect(await alertedRpc(a.id!, a.lease!)).toBe(false);
      await db.query('SELECT public.mfa_backup_code_release($1, $2, $3)', [a.id, OWNER_ID, a.lease]);
      expect(await factors(OWNER_ID)).toBe(1);
      expect((await codeRow(ownerCodes[0])).status).toBe('used');
    });

    it('a handler that lost its lease before sign-out stops: no sign-out, no finalize, nothing removed', async () => {
      const signOutEverywhere = vi.fn(async () => {});
      const finalize = vi.fn(async () => {});
      const res = await redeem(
        dbDeps({
          signOutEverywhere,
          finalize,
          async renewLease() {
            // Another request took the code over while this one was sending the alert.
            await db.query(`UPDATE public.mfa_backup_codes SET lease_token = gen_random_uuid() WHERE status = 'reserved'`);
            return false;
          },
        }),
        OWNER_ID,
        ownerCodes[0],
      );
      expect(res.status).toBe(502);
      expect(signOutEverywhere).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(await factors(OWNER_ID)).toBe(1);
    });

    it('a handler whose finalize finds the lease lost removes nothing', async () => {
      const res = await redeem(
        dbDeps({
          async signOutEverywhere() {
            events.push('sign-out');
            await db.query(`UPDATE public.mfa_backup_codes SET lease_token = gen_random_uuid() WHERE status = 'reserved'`);
          },
        }),
        OWNER_ID,
        ownerCodes[0],
      );
      expect(res.status).toBe(502);
      expect(await factors(OWNER_ID)).toBe(1);
      expect((await codeRow(ownerCodes[0])).status).toBe('reserved');
    });

    it('release acts only for the lease holder', async () => {
      const a = await claimRpc(OWNER_ID, ownerCodes[1]);
      await db.query('SELECT public.mfa_backup_code_release($1, $2, $3)', [a.id, OWNER_ID, randomUUID()]);
      expect((await codeRow(ownerCodes[1])).status).toBe('reserved');
      await db.query('SELECT public.mfa_backup_code_release($1, $2, $3)', [a.id, OWNER_ID, a.lease]);
      expect((await codeRow(ownerCodes[1])).status).toBe('active');
    });
  });

  it('one rate-limit call (address, then global), before the body is read', async () => {
    const server = serviceClient(db);
    const calls: string[] = [];
    const counting = {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        calls.push(`${fn}:${String(args?.p_action)}`);
        return server.rpc(fn, args);
      },
    };
    const claim = vi.fn();
    const deps = dbDeps({
      claim,
      publicLimits: (ip, userAgent) =>
        checkPublicLimits(counting, { action: 'mfa_recovery', ip, userAgent, perIp: { max: 2, windowMinutes: 15 }, global: { max: 3, windowMinutes: 15 } }),
    });
    const send = (ip: string) => {
      const token = tokenFor(OWNER_ID);
      tokens.set(token, OWNER_ID);
      return createMfaRecoveryHandler(deps)(edgeRequest({ headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': ip }, body: '{not json' }));
    };
    // What the one call recorded: the address rows by address, and the shared rows.
    const buckets = async () => ({
      ip: Object.fromEntries(
        (await db.query<{ ip: string; n: number }>(
          `SELECT host(ip_address) AS ip, count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'mfa_recovery.ip' GROUP BY 1`,
        )).rows.map((r) => [r.ip, r.n]),
      ),
      global: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'mfa_recovery.global'`)).rows[0].n,
    });

    expect((await send('203.0.113.7')).status).toBe(400);
    expect(calls).toEqual(['check_public_rate_limit:mfa_recovery']);
    expect((await send('203.0.113.7')).status).toBe(400);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2 }, global: 2 });
    // The third from one address stops at its own bucket: nothing recorded, none of the
    // shared ceiling spent.
    expect((await send('203.0.113.7')).status).toBe(429);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2 }, global: 2 });
    // Another address passes its own bucket; a fresh one after it is stopped by the shared
    // ceiling and leaves no address row behind.
    expect((await send('198.51.100.9')).status).toBe(400);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2, '198.51.100.9': 1 }, global: 3 });
    expect((await send('192.0.2.44')).status).toBe(429);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2, '198.51.100.9': 1 }, global: 3 });
    expect(calls).toHaveLength(5);
    expect(claim).not.toHaveBeenCalled();
  });

  it('a code another request holds and has not alerted is answered "try again", not taken', async () => {
    const hash = await hashCode(normalizeBackupCode(ownerCodes[0])!);
    await db.query(`UPDATE public.mfa_backup_codes SET status = 'reserved', reserved_at = now() WHERE code_hash = $1`, [hash]);
    const res = await redeem(dbDeps(), OWNER_ID, ownerCodes[0]);
    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });

  it("View as client cannot strip the client's factors", async () => {
    await db.query(
      `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id)
       SELECT $1, contact_id, user_id, 'ada@example.com', $3 FROM public.client_portal_accounts WHERE user_id = $2`,
      [OWNER_ID, clientUser, MINTED],
    );
    const claim = vi.fn();
    const res = await redeem(dbDeps({ claim }), clientUser, clientCodes[0], MINTED);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('impersonation_read_only');
    expect(claim).not.toHaveBeenCalled();
    expect(await factors(clientUser)).toBe(1);
  });

  it('when the impersonation lookup fails it refuses', async () => {
    const res = await redeem(dbDeps({ isViewAsClient: async () => true }), clientUser, clientCodes[0]);
    expect(res.status).toBe(403);
  });

  it('refuses the system actor, a suspended client and anyone with no account', async () => {
    await db.query(`UPDATE public.client_portal_accounts SET status = 'suspended' WHERE user_id = $1`, [clientUser]);
    const stranger = randomUUID();
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'stranger@example.com')`, [stranger]);
    for (const userId of [SYSTEM_ID, clientUser, stranger]) {
      const res = await redeem(dbDeps(), userId, clientCodes[0]);
      expect(res.status, userId).toBe(403);
    }
    expect(events).toEqual([]);
  });

  it('a request with no live session is 401 and reads no code', async () => {
    const claim = vi.fn();
    const handler = createMfaRecoveryHandler(dbDeps({ claim }));
    for (const headers of [{}, { Authorization: 'Bearer dead-token' }] as Record<string, string>[]) {
      expect((await handler(edgeRequest({ headers, body: { code: ownerCodes[0] } }))).status).toBe(401);
    }
    expect(claim).not.toHaveBeenCalled();
  });

  it('five tries per user per quarter hour, counted before any code is looked at', async () => {
    for (let i = 0; i < 5; i++) expect((await redeem(dbDeps(), OWNER_ID, 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).status).toBe(400);
    const claim = vi.fn();
    expect((await redeem(dbDeps({ claim }), OWNER_ID, ownerCodes[0])).status).toBe(429);
    expect(claim).not.toHaveBeenCalled();
  });

  it('logs no address', async () => {
    await redeem(dbDeps({ sendEmail: async () => { throw new Error('could not send to owner@example.test'); } }), OWNER_ID, ownerCodes[0]);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toMatch(/@example\./);
  });
});
