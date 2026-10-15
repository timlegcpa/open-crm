// @vitest-environment node
// accept-portal-invite against the real migrations in PGlite. Only Supabase Auth is
// faked, and it records every call, so each latch is checked by what it did: the user is
// created banned and stamped, un-banned only after the link, removed when the link
// fails, and a stale user is replaced only when it carries THIS invitation's stamp.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import {
  createAcceptInviteHandler,
  type AcceptInviteDeps,
  type InvitationRow,
} from '../../../supabase/functions/accept-portal-invite/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { PORTAL_USER_BAN_DURATION } from '../../../supabase/functions/_shared/portal-account';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

const TOKEN = 'T'.repeat(43);
const PASSWORD = 'Correct-Horse-9';

interface FakeUser {
  id: string;
  email: string;
  banned: boolean;
  pendingInvite: string | null;
}

let db: PGlite;
let contactId: string;
let invitationId: string;
/** A fresh address per test: one database serves the file, and addresses are global to Auth. */
let EMAIL: string;
let n = 0;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/**
 * The fake Auth: users live in auth.users too, with the stamp (raw_app_meta_data) and the
 * ban (banned_until) where Auth keeps them, so the foreign keys and the database's own
 * stale-user check behave as on a project.
 */
async function mirror(user: FakeUser): Promise<void> {
  await db.query(
    `UPDATE auth.users SET raw_app_meta_data = $2, banned_until = CASE WHEN $3 THEN now() + interval '100 years' END WHERE id = $1`,
    [user.id, JSON.stringify(user.pendingInvite ? { pending_invite: user.pendingInvite } : {}), user.banned]);
}

function fakeAuth() {
  const users = new Map<string, FakeUser>();
  const calls: string[] = [];
  return {
    users,
    calls,
    async create(email: string, invitation: string): Promise<{ userId: string } | { alreadyRegistered: true }> {
      calls.push('create');
      if ([...users.values()].some((u) => u.email.toLowerCase() === email.toLowerCase())) return { alreadyRegistered: true };
      const id = randomUUID();
      await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
      const user = { id, email, banned: true, pendingInvite: invitation };
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
    async remove(id: string) {
      calls.push('delete');
      users.delete(id);
      await db.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
    },
  };
}

function deps(auth: ReturnType<typeof fakeAuth>, over: Partial<AcceptInviteDeps> = {}): AcceptInviteDeps {
  const server = serviceClient(db);
  return {
    allowedOrigins: ['http://localhost:5173'],
    rateLimit: async () => 'allowed',
    async findInvitation(hash) {
      const [row] = await rows<InvitationRow>(
        `SELECT id, contact_id, email, status, expires_at::text FROM public.portal_invitations WHERE token_hash = $1`, [hash]);
      return row ?? null;
    },
    async markExpired(id) {
      await db.query(`UPDATE public.portal_invitations SET status = 'expired' WHERE id = $1`, [id]);
    },
    async countAttempt(id) {
      const { data, error } = await server.rpc('increment_invitation_attempt', { invitation_id: id, max_attempts: 5 });
      if (error) throw error;
      return (data as number | null) ?? null;
    },
    createBannedUser: ({ email, invitationId: inv }) => auth.create(email, inv),
    async findUserIdByEmail(email) {
      const { data, error } = await server.rpc('find_auth_user_id_by_email', { target_email: email });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    async claim(inv, claim) {
      const { data, error } = await server.rpc('claim_portal_invitation', { p_invitation_id: inv, p_claim: claim });
      if (error) throw error;
      return data === true;
    },
    async releaseClaim(inv, claim) {
      const { error } = await server.rpc('release_portal_invitation_claim', { p_invitation_id: inv, p_claim: claim });
      if (error) throw error;
    },
    async deleteStaleUser(id, inv, claim) {
      const { data, error } = await server.rpc('delete_stale_portal_user', { p_user: id, p_invitation_id: inv, p_claim: claim });
      if (error) throw error;
      if (data === true) {
        auth.calls.push('delete');
        auth.users.delete(id);
      }
      return data === true;
    },
    deleteUser: (id) => auth.remove(id),
    async banUser(id) {
      auth.calls.push('ban');
      const u = auth.users.get(id);
      if (u) {
        u.banned = true;
        await mirror(u);
      }
    },
    async link(inv, userId) {
      auth.calls.push('link');
      const { data, error } = await server.rpc('link_portal_invitation', { p_invitation_id: inv, p_user_id: userId });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    async activateUser(id) {
      auth.calls.push('activate');
      const u = auth.users.get(id)!;
      u.banned = false;
      u.pendingInvite = null;
      await mirror(u);
    },
    async markAccepted(id) {
      await db.query(`UPDATE public.portal_invitations SET status = 'accepted', accepted_at = now(), token_hash = NULL WHERE id = $1`, [id]);
    },
    async logAccepted({ contactId: c, userId, invitationId: inv }) {
      await db.query(
        `INSERT INTO public.client_activity_log (contact_id, user_id, action, details) VALUES ($1, $2, 'invitation_accepted', $3)`,
        [c, userId, JSON.stringify({ invitation_id: inv, actor_role: 'client' })]);
    },
    notifyOwner: async () => {},
    logSink: () => {},
    ...over,
  };
}

const accept = (d: AcceptInviteDeps, body: Record<string, unknown> = {}) =>
  createAcceptInviteHandler(d)(edgeRequest({ body: { token: TOKEN, password: PASSWORD, display_name: 'Ada', ...body } }));

async function invitationStatus(): Promise<string> {
  return (await rows<{ status: string }>(`SELECT status FROM public.portal_invitations WHERE id = $1`, [invitationId]))[0].status;
}

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  EMAIL = `ada-${n}@example.com`;
  // One token for every test (the contract's body is fixed): earlier tests' links let go of it.
  await db.query(`UPDATE public.portal_invitations SET token_hash = NULL WHERE token_hash = $1`, [await sha256Hex(TOKEN)]);
  contactId = await seedContact(db, { email: EMAIL });
  const [row] = await rows<{ id: string }>(
    `SELECT public.create_portal_invitation($1, $2, $3, now() + interval '7 days', NULL) AS id`, [contactId, EMAIL, await sha256Hex(TOKEN)]);
  invitationId = row.id;
});

describeEdgeContract({
  name: 'accept-portal-invite',
  handler: async (req) => createAcceptInviteHandler(deps(fakeAuth()))(req),
  failingHandler: async (req) => createAcceptInviteHandler(deps(fakeAuth(), { findInvitation: throwInternal }))(req),
  limitedHandler: async (req) => createAcceptInviteHandler(deps(fakeAuth(), { rateLimit: async () => 'limited' }))(req),
  credentials: null,
  body: { kind: 'json', valid: { token: TOKEN, password: PASSWORD }, maxBytes: 8000 },
});

describe('accept-portal-invite', () => {
  it('creates the user banned and stamped, links it, then lifts the ban; the link is used up', async () => {
    const auth = fakeAuth();
    const res = await accept(deps(auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, email: EMAIL });
    expect(auth.calls).toEqual(['create', 'link', 'activate']);
    const [user] = auth.users.values();
    expect(user).toMatchObject({ banned: false, pendingInvite: null });
    const [account] = await rows<{ user_id: string; status: string }>(`SELECT user_id, status FROM public.client_portal_accounts WHERE contact_id = $1`, [contactId]);
    expect(account).toEqual({ user_id: user.id, status: 'active' });
    expect(await invitationStatus()).toBe('accepted');
    // A reopened link no longer matches anything.
    expect((await accept(deps(fakeAuth()))).status).toBe(400);
  });

  it('a row a contact delete has claimed is never linked: the new user is banned again and deleted, and the link stays redeemable', async () => {
    await db.query(`UPDATE public.client_portal_accounts SET delete_claim = gen_random_uuid(), delete_claimed_at = now() WHERE contact_id = $1`, [contactId]);
    const auth = fakeAuth();
    const res = await accept(deps(auth));
    expect(res.status).toBe(409);
    expect(auth.calls).toEqual(['create', 'link', 'ban', 'delete']);
    expect(auth.users.size).toBe(0);
    expect(await invitationStatus()).toBe('pending');
  });

  it('a link that throws (the claim trigger) takes the same rollback', async () => {
    const auth = fakeAuth();
    const res = await accept(deps(auth, { link: async () => { throw new Error('contact_delete_in_progress'); } }));
    expect(res.status).toBe(409);
    expect(auth.calls).toEqual(['create', 'ban', 'delete']);
  });

  it('never deletes a registered user that this invitation did not create', async () => {
    const auth = fakeAuth();
    await auth.add({ email: EMAIL, banned: false, pendingInvite: null });
    const res = await accept(deps(auth));
    expect(res.status).toBe(409);
    expect(auth.calls).toEqual(['create']);
    expect(auth.users.size).toBe(1);
  });

  it('never deletes a user stamped for ANOTHER invitation, even one with no account', async () => {
    const auth = fakeAuth();
    await auth.add({ email: EMAIL, banned: true, pendingInvite: randomUUID() });
    expect((await accept(deps(auth))).status).toBe(409);
    expect(auth.calls).toEqual(['create']);
  });

  it('never replaces a live login on the same contact whose stamp was cleared (a replayed token)', async () => {
    const auth = fakeAuth();
    const live = await auth.add({ email: EMAIL, banned: false, pendingInvite: null });
    await db.query(`UPDATE public.client_portal_accounts SET user_id = $1, status = 'active' WHERE contact_id = $2`, [live, contactId]);
    expect((await accept(deps(auth))).status).toBe(409);
    expect(auth.users.has(live)).toBe(true);
  });

  it('replaces an abandoned attempt at THIS invitation and finishes', async () => {
    const auth = fakeAuth();
    const stale = await auth.add({ email: EMAIL, banned: true, pendingInvite: invitationId });
    const res = await accept(deps(auth));
    expect(res.status).toBe(200);
    expect(auth.users.has(stale)).toBe(false);
    expect(auth.calls).toEqual(['create', 'delete', 'create', 'link', 'activate']);
  });

  it('a failed un-ban leaves the account linked but blocked, and says so', async () => {
    const auth = fakeAuth();
    const res = await accept(deps(auth, { activateUser: async () => { throw new Error('auth down'); } }));
    expect(res.status).toBe(409);
    expect([...auth.users.values()][0].banned).toBe(true);
    expect(await invitationStatus()).toBe('pending');
  });

  it('refuses a weak password before looking the link up', async () => {
    const auth = fakeAuth();
    let looked = false;
    const res = await accept(deps(auth, { findInvitation: async () => { looked = true; return null; } }), { password: 'short' });
    expect(res.status).toBe(400);
    expect(looked).toBe(false);
  });

  it('allows five attempts per invitation, counted in the database', async () => {
    await db.query(`UPDATE public.portal_invitations SET attempt_count = 5 WHERE id = $1`, [invitationId]);
    const auth = fakeAuth();
    expect((await accept(deps(auth))).status).toBe(429);
    expect(auth.calls).toEqual([]);
  });

  it('an expired link is marked expired and refused', async () => {
    await db.query(`UPDATE public.portal_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [invitationId]);
    expect((await accept(deps(fakeAuth()))).status).toBe(400);
    expect(await invitationStatus()).toBe('expired');
  });

  it('records the acceptance with the actor stated', async () => {
    await accept(deps(fakeAuth()));
    const [row] = await rows<{ details: Record<string, unknown> }>(`SELECT details FROM public.client_activity_log WHERE action = 'invitation_accepted' AND contact_id = $1`, [contactId]);
    expect(row.details).toEqual({ invitation_id: invitationId, actor_role: 'client' });
  });

  it('two acceptances of one link at once: the second is refused and deletes nothing', async () => {
    const auth = fakeAuth();
    // A barrier: the first acceptance stops right after creating its user, still banned
    // and stamped, which is when the race once let the second delete it.
    let reachedBarrier: () => void = () => {};
    const atBarrier = new Promise<void>((r) => (reachedBarrier = r));
    let openBarrier: () => void = () => {};
    const barrier = new Promise<void>((r) => (openBarrier = r));
    const first = accept(deps(auth, {
      createBannedUser: async (input) => {
        const made = await auth.create(input.email, input.invitationId);
        reachedBarrier();
        await barrier;
        return made;
      },
    }));
    await atBarrier;
    const second = await accept(deps(auth), { password: 'Other-Horse-77' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'in_progress' });
    expect(auth.calls).toEqual(['create']);
    openBarrier();
    const won = await first;
    expect(won.status).toBe(200);
    expect(auth.users.size).toBe(1);
    expect([...auth.users.values()][0]).toMatchObject({ banned: false, pendingInvite: null });
    // Released at the end: the link is used up now, not merely busy.
    expect(await rows(`SELECT 1 FROM public.portal_invitation_claims WHERE invitation_id = $1`, [invitationId])).toHaveLength(0);
    expect((await accept(deps(fakeAuth()))).status).toBe(400);
  });

  it('a failed acceptance lets go of its claim, so a retry can run', async () => {
    await db.query(`UPDATE public.client_portal_accounts SET delete_claim = gen_random_uuid(), delete_claimed_at = now() WHERE contact_id = $1`, [contactId]);
    expect((await accept(deps(fakeAuth()))).status).toBe(409);
    expect(await rows(`SELECT 1 FROM public.portal_invitation_claims WHERE invitation_id = $1`, [invitationId])).toHaveLength(0);
  });

  it('strips CR, LF and NUL from the display name', async () => {
    let seen = '';
    const auth = fakeAuth();
    await accept(deps(auth, { createBannedUser: async (input) => { seen = input.displayName; return auth.create(input.email, input.invitationId); } }), { display_name: 'Ada\r\nBcc: x\0' });
    expect(seen).toBe('Ada  Bcc: x');
    expect(PORTAL_USER_BAN_DURATION).toBe('876000h');
  });
});
