// @vitest-environment node
// accept-start-link against the real migrations in PGlite. Only Supabase Auth is faked,
// and it records every call, so each latch is checked by what it did: the user is created
// banned and stamped, un-banned only after the link, removed when the link fails, a stale
// user is replaced only when the database agrees it is an abandoned attempt, and the link
// is retired (its token stops resolving) only once the account works.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import {
  createAcceptStartLinkHandler,
  type AcceptStartLinkDeps,
  type StartLinkRow,
} from '../../../supabase/functions/accept-start-link/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';

const TOKEN = 'L'.repeat(43);
const PASSWORD = 'Correct-Horse-9';

interface FakeUser {
  id: string;
  email: string;
  banned: boolean;
  stamp: string | null;
}

let db: PGlite;
let contactId: string;
let listId: string;
let linkId: string;
let EMAIL: string;
let n = 0;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}
const one = async <T>(sql: string, params: unknown[] = []) => (await q<{ r: T }>(sql, params))[0].r;

/** Auth's users live in auth.users too, with the stamp and the ban where Auth keeps them. */
async function mirror(user: FakeUser): Promise<void> {
  await db.query(
    `UPDATE auth.users SET raw_app_meta_data = $2, banned_until = CASE WHEN $3 THEN now() + interval '100 years' END WHERE id = $1`,
    [user.id, JSON.stringify(user.stamp ? { pending_signup: user.stamp } : {}), user.banned]);
}

function fakeAuth() {
  const users = new Map<string, FakeUser>();
  const calls: string[] = [];
  return {
    users,
    calls,
    async create(email: string, stamp: string): Promise<{ userId: string } | { alreadyRegistered: true }> {
      calls.push('create');
      const taken = (await db.query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [email])).rows.length > 0;
      if (taken) return { alreadyRegistered: true };
      const id = randomUUID();
      await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
      const user = { id, email, banned: true, stamp };
      users.set(id, user);
      await mirror(user);
      return { userId: id };
    },
    async add(user: Omit<FakeUser, 'id'>): Promise<string> {
      const id = randomUUID();
      await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, user.email]);
      users.set(id, { id, ...user });
      await mirror({ id, ...user });
      return id;
    },
  };
}

function deps(auth: ReturnType<typeof fakeAuth>, over: Partial<AcceptStartLinkDeps> = {}): AcceptStartLinkDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    rateLimit: async () => 'allowed',
    async lookup(hash) {
      const [row] = await q<StartLinkRow>(
        `SELECT id, email, contact_id, needs_list_id, status, expires_at::text, access_revoked FROM public.start_link_lookup($1)`, [hash]);
      return row ?? null;
    },
    expire: async (id) => { await q(`SELECT public.expire_start_link($1)`, [id]); },
    claim: (id, c) => one(`SELECT public.claim_start_link($1, $2) AS r`, [id, c]),
    releaseClaim: async (id, c) => { await q(`SELECT public.release_start_link_claim($1, $2)`, [id, c]); },
    createBannedUser: ({ email, linkId: id }) => auth.create(email, id),
    findUserIdByEmail: (email) => one(`SELECT public.find_auth_user_id_by_email($1) AS r`, [email]),
    async deleteStaleUser(userId, id, c) {
      const deleted = await one<boolean>(`SELECT public.delete_stale_start_link_user($1, $2, $3) AS r`, [userId, id, c]);
      if (deleted) {
        auth.calls.push('delete-stale');
        auth.users.delete(userId);
      }
      return deleted;
    },
    async banUser(id) {
      auth.calls.push('ban');
      const u = auth.users.get(id);
      if (u) {
        u.banned = true;
        await mirror(u);
      }
    },
    async deleteUser(id) {
      auth.calls.push('delete');
      auth.users.delete(id);
      await db.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
    },
    async link(id, userId, c) {
      auth.calls.push('link');
      return one(`SELECT public.link_start_link($1, $2, $3) AS r`, [id, userId, c]);
    },
    async activateUser(id) {
      auth.calls.push('activate');
      const u = auth.users.get(id)!;
      u.banned = false;
      u.stamp = null;
      await mirror(u);
    },
    retire: (id) => one(`SELECT public.retire_start_link($1) AS r`, [id]),
    async logConsumed({ contactId: c, userId, linkId: id, revokedInvites }) {
      await q(`INSERT INTO public.client_activity_log (contact_id, user_id, action, details) VALUES ($1, $2, 'start_link_consumed', $3)`,
        [c, userId, JSON.stringify({ pending_request_id: id, revoked_invites: revokedInvites, actor_role: 'client' })]);
    },
    notifyOwner: async () => {},
    logSink: () => {},
    ...over,
  };
}

const accept = async (d: AcceptStartLinkDeps, body: Record<string, unknown> = {}) => {
  const res = await createAcceptStartLinkHandler(d)(edgeRequest({ body: { token: TOKEN, password: PASSWORD, ...body } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const linkStatus = async () =>
  (await q<{ status: string; token_hash: string }>(`SELECT status, token_hash FROM public.pending_signup_requests WHERE id = $1`, [linkId]))[0];
const accounts = () =>
  q<{ user_id: string | null; status: string; role: string }>(`SELECT user_id, status, role FROM public.client_portal_accounts WHERE contact_id = $1 ORDER BY created_at`, [contactId]);

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  EMAIL = `grace-${n}@example.com`;
  await db.query(`DELETE FROM public.pending_signup_requests WHERE token_hash = $1`, [await sha256Hex(TOKEN)]);
  contactId = await seedContact(db, { first_name: 'Grace', email: EMAIL });
  listId = await one(`INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Docs', 'sent', now()) RETURNING id AS r`, [contactId]);
  linkId = await one(`SELECT public.needs_issue_start_link($1, $2, $3, now() + interval '14 days', NULL, false) AS r`,
    [listId, EMAIL, await sha256Hex(TOKEN)]);
});

describeEdgeContract({
  name: 'accept-start-link',
  handler: async (req) => createAcceptStartLinkHandler(deps(fakeAuth()))(req),
  failingHandler: async (req) => createAcceptStartLinkHandler(deps(fakeAuth(), { lookup: throwInternal }))(req),
  limitedHandler: async (req) => createAcceptStartLinkHandler(deps(fakeAuth(), { rateLimit: async () => 'limited' }))(req),
  credentials: null,
  body: { kind: 'json', valid: { token: TOKEN, password: PASSWORD }, maxBytes: 8000 },
});

describe('accept-start-link', () => {
  it('creates the user banned and stamped, links an account, lifts the ban, and retires the link', async () => {
    const auth = fakeAuth();
    const res = await accept(deps(auth));
    expect(res).toEqual({ status: 200, body: { success: true, email: EMAIL, contact_id: contactId, needs_list_id: listId } });
    expect(auth.calls).toEqual(['create', 'link', 'activate']);
    const [user] = auth.users.values();
    expect(user).toMatchObject({ banned: false, stamp: null });
    expect(await accounts()).toEqual([{ user_id: user.id, status: 'active', role: 'primary' }]);
    expect(await linkStatus()).toEqual({ status: 'consumed', token_hash: `consumed:${linkId}` });
    const [log] = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM public.client_activity_log WHERE action = 'start_link_consumed' AND contact_id = $1`, [contactId]);
    expect(log.details).toEqual({ pending_request_id: linkId, revoked_invites: 0, actor_role: 'client' });
    // The emailed token no longer resolves.
    expect((await accept(deps(fakeAuth()))).status).toBe(404);
  });

  it('a link already used says so', async () => {
    await q(`UPDATE public.pending_signup_requests SET status = 'consumed' WHERE id = $1`, [linkId]);
    expect(await accept(deps(fakeAuth()))).toMatchObject({ status: 410, body: { code: 'link_used' } });
  });

  it('an expired, superseded or revoked link is refused and marked expired, before any user is made', async () => {
    const auth = fakeAuth();
    await q(`UPDATE public.pending_signup_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [linkId]);
    expect(await accept(deps(auth))).toMatchObject({ status: 410, body: { code: 'link_expired' } });
    expect((await linkStatus()).status).toBe('expired');

    await q(`UPDATE public.pending_signup_requests SET status = 'superseded', expires_at = now() + interval '1 day' WHERE id = $1`, [linkId]);
    expect(await accept(deps(auth))).toMatchObject({ status: 410, body: { code: 'link_expired' } });

    await q(`UPDATE public.pending_signup_requests SET status = 'pending' WHERE id = $1`, [linkId]);
    await q(`INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'deactivated', $2)`, [contactId, EMAIL]);
    expect(await accept(deps(auth))).toMatchObject({ status: 410, body: { code: 'link_expired' } });
    expect((await linkStatus()).status).toBe('expired');
    expect(auth.calls).toEqual([]);
  });

  it('a revoke that lands after the checks still wins: the link refuses and the user is rolled back', async () => {
    const auth = fakeAuth();
    const d = deps(auth);
    const create = d.createBannedUser;
    d.createBannedUser = async (input) => {
      const made = await create(input);
      await q(`INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'suspended', $2)`, [contactId, EMAIL]);
      return made;
    };
    const res = await accept(d);
    expect(res).toMatchObject({ status: 409, body: { code: 'portal_account_unavailable' } });
    expect(auth.calls).toEqual(['create', 'link', 'ban', 'delete']);
    expect(auth.users.size).toBe(0);
    expect((await linkStatus()).status).toBe('pending');
  });

  it('reuses the open invited account for the address, and revokes its pending invitation', async () => {
    const invited = await one<string>(
      `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email) VALUES ($1, 'invited', $2) RETURNING id AS r`, [contactId, EMAIL.toUpperCase()]);
    const invite = await one<string>(
      `INSERT INTO public.portal_invitations (email, contact_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '7 days') RETURNING id AS r`,
      [EMAIL, contactId, randomUUID()]);
    const res = await accept(deps(fakeAuth()));
    expect(res.status).toBe(200);
    const rows = await accounts();
    expect(rows).toHaveLength(1);
    expect((await q<{ id: string; status: string }>(`SELECT id, status FROM public.client_portal_accounts WHERE id = $1`, [invited]))[0].status).toBe('active');
    expect((await q<{ status: string }>(`SELECT status FROM public.portal_invitations WHERE id = $1`, [invite]))[0].status).toBe('revoked');
  });

  it('never replaces a registered user the database does not call abandoned', async () => {
    const auth = fakeAuth();
    await auth.add({ email: EMAIL, banned: false, stamp: null });
    expect(await accept(deps(auth))).toMatchObject({ status: 409, body: { code: 'already_registered' } });
    expect(auth.calls).toEqual(['create']);
    expect(auth.users.size).toBe(1);
  });

  it('replaces an abandoned attempt at this link and finishes', async () => {
    const auth = fakeAuth();
    const stale = await auth.add({ email: EMAIL, banned: true, stamp: linkId });
    const res = await accept(deps(auth));
    expect(res.status).toBe(200);
    expect(auth.users.has(stale)).toBe(false);
    expect(auth.calls).toEqual(['create', 'delete-stale', 'create', 'link', 'activate']);
  });

  it('a failed un-ban leaves the account linked but locked, and the link live', async () => {
    const auth = fakeAuth();
    const res = await accept(deps(auth, { activateUser: async () => { throw new Error('auth down'); } }));
    expect(res).toMatchObject({ status: 500, body: { code: 'account_locked' } });
    expect([...auth.users.values()][0].banned).toBe(true);
    expect((await linkStatus()).status).toBe('pending');
  });

  it('retires twice before failing closed', async () => {
    let tries = 0;
    const ok = await accept(deps(fakeAuth(), {
      retire: async (id) => {
        tries++;
        if (tries === 1) throw new Error('blip');
        return one(`SELECT public.retire_start_link($1) AS r`, [id]);
      },
    }));
    expect([ok.status, tries]).toEqual([200, 2]);
  });

  it('a retire that keeps failing is an error, not a quiet success', async () => {
    const res = await accept(deps(fakeAuth(), { retire: async () => { throw new Error('down'); } }));
    expect(res).toMatchObject({ status: 500, body: { code: 'retire_failed' } });
  });

  it('refuses a weak password or a mismatch before looking the link up', async () => {
    let looked = false;
    const d = deps(fakeAuth(), { lookup: async () => { looked = true; return null; } });
    expect((await accept(d, { password: 'short' })).status).toBe(400);
    expect((await accept(d, { confirm_password: 'Different-Horse-9' })).body.code).toBe('password_mismatch');
    expect((await accept(d, { token: 'short' })).body.code).toBe('invalid_link');
    expect(looked).toBe(false);
  });

  it('two redemptions at once: the second is refused and deletes nothing', async () => {
    const auth = fakeAuth();
    let reached: () => void = () => {};
    const atBarrier = new Promise<void>((r) => (reached = r));
    let open: () => void = () => {};
    const barrier = new Promise<void>((r) => (open = r));
    const first = accept(deps(auth, {
      createBannedUser: async (input) => {
        const made = await auth.create(input.email, input.linkId);
        reached();
        await barrier;
        return made;
      },
    }));
    await atBarrier;
    const second = await accept(deps(auth), { password: 'Other-Horse-77' });
    expect(second).toMatchObject({ status: 409, body: { code: 'in_progress' } });
    expect(auth.calls).toEqual(['create']);
    open();
    expect((await first).status).toBe(200);
    expect(auth.users.size).toBe(1);
  });

  it('a failed redemption lets go of its claim', async () => {
    await accept(deps(fakeAuth(), { link: async () => { throw new Error('conflict'); } }));
    const [row] = await q<{ claim: string | null }>(`SELECT claim FROM public.pending_signup_requests WHERE id = $1`, [linkId]);
    expect(row.claim).toBeNull();
  });
});
