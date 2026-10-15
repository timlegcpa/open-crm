// @vitest-environment node
// View as client, start to end, against the real migrations in PGlite. Supabase Auth is
// faked with what matters here: a magic link is single-use, and redeeming it creates an
// auth.sessions row (amr 'otp') whose id the access token carries as session_id.
//
// The property under test (plan 16b, still open at wave 0): the sign-in link is
// single-use and bound to its row at once. The start redeems the link itself and writes
// the row already bound, so no link outlives the request: nothing is left to redeem
// after the row closes, and the minted session is read-only from its first request.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asClient, createDb, expectDenied, OWNER_ID as DB_OWNER_ID, seedContact, seedCore, seedPortalAccount, session } from '../db/harness';
import { createImpersonateHandler, type ImpersonateDeps, type MintedSession } from '../../../supabase/functions/admin-impersonate/handler';
import { createImpersonateEndHandler, type CredentialChanges, type ImpersonateEndDeps, type SessionRow } from '../../../supabase/functions/admin-impersonate-end/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let clientId: string;
let clientEmail: string;
let n = 0;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: object) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;

/** Supabase Auth, cut to the link and the sessions. */
function fakeAuth() {
  const links = new Map<string, { email: string; used: boolean }>();
  return {
    links,
    generateLink(email: string): string {
      const hashed = randomUUID().replace(/-/g, '');
      links.set(hashed, { email, used: false });
      return hashed;
    },
    async redeem(hashed: string): Promise<MintedSession & { sessionId: string }> {
      const link = links.get(hashed);
      if (!link || link.used) throw new Error('otp_expired');
      link.used = true;
      const [user] = await rows<{ id: string }>(`SELECT id FROM auth.users WHERE lower(email) = lower($1)`, [link.email]);
      const sessionId = randomUUID();
      await db.query(`INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())`, [sessionId, user.id]);
      await db.query(`INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) VALUES ($1, $2, now(), now(), 'otp')`, [randomUUID(), sessionId]);
      return { accessToken: jwt({ sub: user.id, session_id: sessionId }), refreshToken: `refresh-${sessionId}`, expiresAt: 1, sessionId };
    },
  };
}

function startDeps(auth: ReturnType<typeof fakeAuth>, over: Partial<ImpersonateDeps> = {}) {
  const audits: unknown[] = [];
  const revoked: string[] = [];
  let mintedFor: string[] = [];
  const server = serviceClient(db);
  const d: ImpersonateDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    async sweepStale() {
      const { data } = await server.rpc('auto_end_stale_impersonation_sessions');
      return data as number;
    },
    activeAccounts: (c) =>
      rows(`SELECT user_id FROM public.client_portal_accounts WHERE contact_id = $1 AND status = 'active' AND user_id IS NOT NULL ORDER BY created_at, id`, [c]),
    async loadContact(c) {
      const [row] = await rows<{ email: string | null; full_name: string | null }>(`SELECT email, full_name FROM public.contacts WHERE id = $1`, [c]);
      return row ?? null;
    },
    async getAuthUser(id) {
      const [row] = await rows<{ id: string; email: string; banned_until: string | null }>(`SELECT id, email, banned_until::text FROM auth.users WHERE id = $1`, [id]);
      return row ? { id: row.id, email: row.email, bannedUntil: row.banned_until } : null;
    },
    staffIds: async () => [DB_OWNER_ID],
    async aal1Refused(userId) {
      const { data, error } = await server.rpc('mfa_guard_denied', { p_user_id: userId, p_aal: 'aal1', p_iat: Math.floor(Date.now() / 1000) });
      if (error) throw error;
      return data !== false;
    },
    async mintSession(email) {
      mintedFor = [...mintedFor, email];
      return auth.redeem(auth.generateLink(email));
    },
    async revokeMinted(token) {
      revoked.push(token);
    },
    async insertSession(row) {
      const [inserted] = await rows<{ id: string }>(
        `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, target_name, session_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [DB_OWNER_ID, row.contactId, row.targetUserId, row.targetEmail, row.targetName, row.sessionId, row.ip, row.userAgent]);
      return inserted.id;
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, audits, revoked, minted: () => mintedFor };
}

function endDeps(over: Partial<ImpersonateEndDeps> = {}) {
  const audits: unknown[] = [];
  const server = serviceClient(db);
  const d: ImpersonateEndDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: async (token) => (token === 'db-owner' ? { ok: true, principal: { kind: 'owner', userId: DB_OWNER_ID } } : fakeOwnerAuth()(token)),
    async loadSession(id) {
      const [row] = await rows<SessionRow>(`SELECT id, owner_user_id, started_at::text, ended_at::text FROM public.impersonation_sessions WHERE id = $1`, [id]);
      return row ?? null;
    },
    async revoke(id) {
      const { data, error } = await server.rpc('revoke_impersonation_auth_session', { p_row: id });
      if (error) throw error;
      return data === true;
    },
    async end(id) {
      return (await rows(`UPDATE public.impersonation_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING id`, [id])).length === 1;
    },
    async credentialChanges(id) {
      const { data, error } = await server.rpc('impersonation_credential_changes', { p_row: id });
      if (error) throw error;
      return (data as CredentialChanges | null) ?? null;
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, audits };
}

const start = (d: ImpersonateDeps, body: unknown = { contact_id: contactId }) =>
  createImpersonateHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));
const end = (d: ImpersonateEndDeps, rowId: string, token = 'db-owner') =>
  createImpersonateEndHandler(d)(edgeRequest({ headers: { Authorization: `Bearer ${token}` }, body: { session_id: rowId } }));

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  clientEmail = `ada-${n}@example.com`;
  contactId = await seedContact(db, { email: clientEmail, first_name: 'Ada', last_name: 'Lovelace' });
  clientId = (await seedPortalAccount(db, contactId, { email: clientEmail })).userId;
});

describeEdgeContract({
  name: 'admin-impersonate',
  handler: async (req) => createImpersonateHandler(startDeps(fakeAuth()).d)(req),
  failingHandler: async (req) => createImpersonateHandler(startDeps(fakeAuth(), { activeAccounts: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { contact_id: '10000000-0000-4000-8000-000000000999' }, maxBytes: 1024 },
});

describeEdgeContract({
  name: 'admin-impersonate-end',
  handler: async (req) => createImpersonateEndHandler(endDeps().d)(req),
  failingHandler: async (req) => createImpersonateEndHandler(endDeps({ loadSession: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { session_id: '10000000-0000-4000-8000-000000000999' }, maxBytes: 1024 },
});

describe('View as client: the link is single-use and bound at once', () => {
  it('hands back a session, never a link, with its row already bound', async () => {
    const auth = fakeAuth();
    const { d, audits } = startDeps(auth);
    const res = await start(d);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['access_token', 'client_user_id', 'contact_id', 'contact_name', 'expires_at', 'refresh_token', 'session_id']);
    for (const hashed of auth.links.keys()) expect(text).not.toContain(hashed);
    expect([...auth.links.values()].every((l) => l.used)).toBe(true);

    const [row] = await rows<{ session_id: string; target_user_id: string; ended_at: string | null }>(
      `SELECT session_id, target_user_id, ended_at FROM public.impersonation_sessions WHERE id = $1`, [body.session_id]);
    const [minted] = await rows<{ id: string }>(`SELECT id FROM auth.sessions WHERE user_id = $1`, [clientId]);
    expect(row).toEqual({ session_id: minted.id, target_user_id: clientId, ended_at: null });
    expect(body).toMatchObject({ client_user_id: clientId, contact_name: 'Ada Lovelace' });
    expect(audits).toEqual([expect.objectContaining({ ownerId: OWNER_ID, details: { session_id: body.session_id, target_contact_id: contactId, target_user_id: clientId } })]);
  });

  it('the minted session is read-only from its first request, and the client’s own device is not', async () => {
    const { d } = startDeps(fakeAuth());
    const body = (await (await start(d)).json()) as { session_id: string };
    const [{ session_id: minted }] = await rows<{ session_id: string }>(`SELECT session_id FROM public.impersonation_sessions WHERE id = $1`, [body.session_id]);
    const [{ id: task }] = await rows<{ id: string }>(`INSERT INTO public.client_tasks (contact_id, title) VALUES ($1, 'Send the form') RETURNING id`, [contactId]);
    const complete = `UPDATE public.client_tasks SET status = 'completed' WHERE id = $1`;
    const err = await expectDenied(session(db, asClient(clientId, { sessionId: minted }), (tx) => tx.query(complete, [task])));
    expect(err.message).toBe('impersonation_read_only');
    await session(db, asClient(clientId, { sessionId: randomUUID() }), (tx) => tx.query(complete, [task]));
  });

  it('ending deletes exactly the minted session; no link is left to redeem afterwards', async () => {
    const auth = fakeAuth();
    const { d } = startDeps(auth);
    const body = (await (await start(d)).json()) as { session_id: string };
    // The client's own device, signed in with a password before and during the view.
    const own = randomUUID();
    await db.query(`INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())`, [own, clientId]);
    await db.query(`INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) VALUES ($1, $2, now(), now(), 'password')`, [randomUUID(), own]);

    const e = endDeps();
    const res = await end(e.d, body.session_id);
    expect(await res.json()).toEqual({ success: true, already_ended: false, session_revoked: true });
    expect((await rows<{ id: string }>(`SELECT id FROM auth.sessions WHERE user_id = $1`, [clientId])).map((r) => r.id)).toEqual([own]);

    // Inside the link's hour, after the close: every link the start minted is spent.
    for (const hashed of auth.links.keys()) await expect(auth.redeem(hashed)).rejects.toThrow('otp_expired');
    expect(e.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ session_id: body.session_id, session_revoked: true }) })]);
  });

  it('a row that could not be written leaves no session alive: the minted one is revoked and nothing is returned', async () => {
    const auth = fakeAuth();
    const { d, revoked } = startDeps(auth, { insertSession: async () => { throw new Error('insert failed'); } });
    const res = await start(d);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/access_token|refresh/);
    expect(revoked).toHaveLength(1);
  });

  it('a token with no session id is revoked, not recorded unbound', async () => {
    const { d, revoked } = startDeps(fakeAuth(), {
      mintSession: async () => ({ accessToken: jwt({ sub: clientId }), refreshToken: 'r', expiresAt: null }),
    });
    expect((await start(d)).status).toBe(500);
    expect(revoked).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM public.impersonation_sessions WHERE target_contact_id = $1`, [contactId])).toHaveLength(0);
  });
});

describe('admin-impersonate refusals', () => {
  it('refuses a client with a verified second factor, before minting anything', async () => {
    await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [clientId]);
    const { d, audits, minted } = startDeps(fakeAuth());
    const res = await start(d);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'target_has_mfa' });
    expect(minted()).toEqual([]);
    expect(audits).toEqual([]);
    expect(await rows(`SELECT 1 FROM public.impersonation_sessions WHERE target_contact_id = $1`, [contactId])).toHaveLength(0);
  });

  it('refuses a banned sign-in, a staff sign-in and a contact with no active account', async () => {
    await db.query(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1`, [clientId]);
    expect((await start(startDeps(fakeAuth()).d)).status).toBe(403);
    await db.query(`UPDATE auth.users SET banned_until = NULL WHERE id = $1`, [clientId]);
    expect((await start(startDeps(fakeAuth(), { staffIds: async () => [clientId] }).d)).status).toBe(403);
    await db.query(`UPDATE public.client_portal_accounts SET status = 'suspended' WHERE contact_id = $1`, [contactId]);
    expect((await start(startDeps(fakeAuth()).d)).status).toBe(404);
  });

  it('picks the sign-in whose address is the contact’s, over an older one', async () => {
    const other = `grace-${n}@example.com`;
    await db.query(`UPDATE public.client_portal_accounts SET created_at = now() WHERE contact_id = $1`, [contactId]);
    const spouse = await seedPortalAccount(db, contactId, { email: other });
    await db.query(`UPDATE public.client_portal_accounts SET created_at = now() - interval '1 day' WHERE id = $1`, [spouse.accountId]);
    const { d, minted } = startDeps(fakeAuth());
    await start(d);
    expect(minted()).toEqual([clientEmail]);
  });
});

describe('admin-impersonate-end', () => {
  async function openRow(owner = DB_OWNER_ID, endedAgo: string | null = null): Promise<{ id: string; sid: string }> {
    const sid = randomUUID();
    await db.query(`INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())`, [sid, clientId]);
    const [row] = await rows<{ id: string }>(
      `INSERT INTO public.impersonation_sessions (owner_user_id, target_contact_id, target_user_id, target_email, session_id, ended_at)
       VALUES ($1, $2, $3, $4, $5, now() - $6::interval) RETURNING id`,
      [owner, contactId, clientId, clientEmail, sid, endedAgo]);
    return { id: row.id, sid };
  }

  it('only the owner who started it may end it', async () => {
    const { id } = await openRow();
    const { d } = endDeps({ authorizeOwner: async () => ({ ok: true, principal: { kind: 'owner', userId: randomUUID() } }) });
    expect((await end(d, id)).status).toBe(403);
  });

  it('revokes even a row that is already ended, and writes no second audit row', async () => {
    const { id, sid } = await openRow(DB_OWNER_ID, '1 minute');
    const e = endDeps();
    expect(await (await end(e.d, id)).json()).toEqual({ success: true, already_ended: true, session_revoked: true });
    expect(await rows(`SELECT 1 FROM auth.sessions WHERE id = $1`, [sid])).toHaveLength(0);
    expect(e.audits).toEqual([]);
  });

  it('a revoke that fails leaves the row open, writes no audit row, and is a failure to retry', async () => {
    const { id, sid } = await openRow();
    const failing = endDeps({ revoke: async () => { throw new Error('auth down'); } });
    const res = await end(failing.d, id);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'revoke_failed' });
    expect((await rows<{ ended_at: string | null }>(`SELECT ended_at FROM public.impersonation_sessions WHERE id = $1`, [id]))[0].ended_at).toBeNull();
    expect(failing.audits).toEqual([]);
    // The retry finishes the job.
    const retry = endDeps();
    expect(await (await end(retry.d, id)).json()).toEqual({ success: true, already_ended: false, session_revoked: true });
    expect(await rows(`SELECT 1 FROM auth.sessions WHERE id = $1`, [sid])).toHaveLength(0);
  });

  it('a missing row is 404', async () => {
    expect((await end(endDeps().d, randomUUID())).status).toBe(404);
  });

  it("the minted session cannot change the client's email or add a factor; the audit row says nothing changed", async () => {
    const { d } = startDeps(fakeAuth());
    const body = (await (await start(d)).json()) as { session_id: string };
    // Auth's endpoints write these tables as Auth's own role, past the data API's rules.
    await expect(db.query(`UPDATE auth.users SET email = 'owner@elsewhere.example' WHERE id = $1`, [clientId])).rejects.toThrow('impersonation_credentials_locked');
    await expect(db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'unverified')`, [clientId])).rejects.toThrow('impersonation_credentials_locked');
    const e = endDeps();
    await end(e.d, body.session_id);
    expect(e.audits).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ credentials_checked: true, password_changed: false, email_changed: false, factors_added: 0 }) }),
    ]);
  });

  it('a factor that got past the lock shows in the audit row', async () => {
    const { d } = startDeps(fakeAuth());
    const body = (await (await start(d)).json()) as { session_id: string };
    await db.exec(`ALTER TABLE auth.mfa_factors DISABLE TRIGGER trg_impersonation_factor_locked`);
    try {
      await db.query(`INSERT INTO auth.mfa_factors (user_id, status) VALUES ($1, 'verified')`, [clientId]);
    } finally {
      await db.exec(`ALTER TABLE auth.mfa_factors ENABLE TRIGGER trg_impersonation_factor_locked`);
    }
    const e = endDeps();
    await end(e.d, body.session_id);
    expect(e.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ credentials_checked: true, factors_added: 1 }) })]);
  });

  it('a credential check that fails still ends the view, and says it was not checked', async () => {
    const { id } = await openRow();
    const e = endDeps({ credentialChanges: throwInternal });
    expect((await end(e.d, id)).status).toBe(200);
    expect(e.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ credentials_checked: false }) })]);
  });
});
