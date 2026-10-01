// @vitest-environment node
// The delete-contact edge handler, run against the real migrations in PGlite. Only the
// Auth boundary is faked: deleting a sign-in user deletes its auth.users row, which is
// what Supabase Auth does to the foreign keys that point at it.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import {
  createDeleteContactHandler,
  type BeginResult,
  type DeleteContactDeps,
} from '../../../supabase/functions/delete-contact/handler';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SYSTEM = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const CONTACT = '10000000-0000-4000-8000-00000000000a';
const OTHER = '10000000-0000-4000-8000-00000000000b';
const ORIGIN = 'http://localhost:5173';
const TOKEN = 'owner-token';

let db: PGlite;

/** One committed statement as the server (service_role), like the edge client. */
async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

function deps(over: Partial<DeleteContactDeps> = {}): DeleteContactDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    allowedOrigins: [ORIGIN],
    authorizeOwner: async (token) => (token === TOKEN ? OWNER : null),
    async begin(contactId) {
      const [row] = await asServer<BeginResult>(`SELECT * FROM public.admin_contact_delete_begin($1)`, [contactId]);
      return row;
    },
    async deleteAuthUser(userId) {
      const gone = await rows(`DELETE FROM auth.users WHERE id = $1 RETURNING id`, [userId]);
      return gone.length ? 'deleted' : 'missing';
    },
    async finish(contactId, claim) {
      const [row] = await asServer<{ ids: string[] }>(`SELECT public.admin_delete_contact($1, $2) AS ids`, [contactId, claim]);
      return row.ids;
    },
    async release(contactId, prior, claim, destroyed) {
      await asServer(`SELECT public.admin_contact_delete_release($1, $2, $3, $4)`, [contactId, JSON.stringify(prior), claim, destroyed]);
    },
    async audit(ownerId, contactId, removed, orphaned) {
      await asServer(`INSERT INTO public.audit_logs (user_id, action, details) VALUES ($1, 'contact_deleted', $2)`, [
        ownerId,
        JSON.stringify({ contact_id: contactId, portal_users_removed: removed, orphaned_sign_ins: orphaned }),
      ]);
    },
    log: (message) => logs.push(message),
    ...over,
  };
}

function request(body: unknown, init: { origin?: string | null; token?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request('http://edge.local/delete-contact', {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'OPTIONS' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const call = (d: DeleteContactDeps, req: Request) => createDeleteContactHandler(d)(req);

beforeEach(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${OWNER}', 'owner@example.test'), ('${SYSTEM}', 'system@example.test'),
      ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id) VALUES ('Example Co', '${OWNER}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, email) VALUES ('${CONTACT}', 'Ada', 'a@example.test'), ('${OTHER}', 'Bo', 'b@example.test');
    INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email, role) VALUES
      ('${CONTACT}', '${USER_A}', 'active', 'a@example.test', 'primary'),
      ('${CONTACT}', '${USER_B}', 'active', 'b@example.test', 'secondary');
  `);
}, 60_000);

describe('delete-contact: who may call it', () => {
  it('refuses a request with no token, a non-owner, and a browser on another origin', async () => {
    const d = deps();
    expect((await call(d, request({ contact_id: CONTACT }, { token: null }))).status).toBe(401);
    expect((await call(d, request({ contact_id: CONTACT }, { token: 'someone-else' }))).status).toBe(403);
    expect((await call(d, request({ contact_id: CONTACT }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect(await rows(`SELECT id FROM public.contacts WHERE id = $1`, [CONTACT])).toHaveLength(1);
  });

  it('treats an authorization failure as signed out, and never reaches the database', async () => {
    const begin = vi.fn();
    const d = deps({ authorizeOwner: async () => { throw new Error('auth down'); }, begin });
    expect((await call(d, request({ contact_id: CONTACT }))).status).toBe(401);
    expect(begin).not.toHaveBeenCalled();
  });

  it('answers a preflight from an allowed origin and refuses one from elsewhere', async () => {
    const ok = await call(deps(), request(null, { method: 'OPTIONS' }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const bad = await call(deps(), request(null, { method: 'OPTIONS', origin: 'https://evil.example' }));
    expect(bad.status).toBe(403);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sends Vary: Origin and the security headers on errors too', async () => {
    const res = await call(deps(), request({ contact_id: 'nope' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a malformed, oversized or lying body before touching the database', async () => {
    const begin = vi.fn();
    const d = deps({ begin });
    expect((await call(d, request('{not json'))).status).toBe(400);
    expect((await call(d, request({ contact_id: CONTACT, pad: 'x'.repeat(5000) }))).status).toBe(413);
    const lying = request({ contact_id: CONTACT, pad: 'x'.repeat(5000) });
    lying.headers.set('Content-Length', '10');
    expect((await call(d, lying)).status).toBe(413);
    expect(begin).not.toHaveBeenCalled();
  });
});

describe('delete-contact: the claim protocol', () => {
  it('deletes the contact, its accounts and their sign-in users, and audits it', async () => {
    const res = await call(deps(), request({ contact_id: CONTACT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await rows(`SELECT id FROM public.contacts WHERE id = $1`, [CONTACT])).toHaveLength(0);
    expect(await rows(`SELECT id FROM public.client_portal_accounts WHERE contact_id = $1`, [CONTACT])).toHaveLength(0);
    expect(await rows(`SELECT id FROM auth.users WHERE id IN ($1, $2)`, [USER_A, USER_B])).toHaveLength(0);
    const [audit] = await rows<{ details: { portal_users_removed: number } }>(
      `SELECT details FROM public.audit_logs WHERE action = 'contact_deleted'`,
    );
    expect(audit.details.portal_users_removed).toBe(2);
    expect(await rows(`SELECT id FROM public.contacts WHERE id = $1`, [OTHER])).toHaveLength(1);
  });

  it('reports an already-deleted contact as done', async () => {
    const res = await call(deps(), request({ contact_id: '10000000-0000-4000-8000-0000000000ff' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, already_gone: true });
  });

  it('counts a sign-in user that was already gone as destroyed', async () => {
    await db.exec(`DELETE FROM auth.users WHERE id = '${USER_B}'`);
    const res = await call(deps(), request({ contact_id: CONTACT }));
    expect(res.status).toBe(200);
    expect(await rows(`SELECT id FROM public.contacts WHERE id = $1`, [CONTACT])).toHaveLength(0);
  });

  it('refuses a second delete while the first holds the claim', async () => {
    await asServer(`SELECT * FROM public.admin_contact_delete_begin($1)`, [CONTACT]);
    const res = await call(deps(), request({ contact_id: CONTACT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'delete_in_progress' });
  });

  it('when a sign-in delete fails, keeps the contact and restores what was not destroyed', async () => {
    // Fail on whichever sign-in comes second, so one is destroyed and one is not
    // whatever order the database returns them in.
    const destroyed: string[] = [];
    const d = deps({
      async deleteAuthUser(userId) {
        if (destroyed.length === 1) throw new Error('auth 500');
        await db.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
        destroyed.push(userId);
        return 'deleted';
      },
    });
    const res = await call(d, request({ contact_id: CONTACT }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The contact could not be deleted. Try again.' });
    const contact = await rows<{ delete_claim: string | null }>(`SELECT delete_claim FROM public.contacts WHERE id = $1`, [CONTACT]);
    expect(contact).toEqual([{ delete_claim: null }]);
    const survivor = [USER_A, USER_B].find((id) => !destroyed.includes(id));
    const accounts = await rows<{ user_id: string | null; status: string }>(
      `SELECT user_id, status FROM public.client_portal_accounts WHERE contact_id = $1`,
      [CONTACT],
    );
    // The destroyed sign-in cannot come back; the untouched one keeps its account and status.
    expect(accounts).toEqual(
      expect.arrayContaining([
        { user_id: null, status: 'deactivated' },
        { user_id: survivor, status: 'active' },
      ]),
    );
    expect(destroyed).toHaveLength(1);
  });

  it('when the final delete fails, releases the claim with the destroyed users', async () => {
    const release = vi.fn(deps().release);
    const d = deps({ finish: async () => { throw new Error('db down'); }, release });
    const res = await call(d, request({ contact_id: CONTACT }));
    expect(res.status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][3].sort()).toEqual([USER_A, USER_B].sort());
    expect(await rows(`SELECT delete_claim FROM public.contacts WHERE id = $1`, [CONTACT])).toEqual([{ delete_claim: null }]);
    const statuses = await rows<{ status: string }>(`SELECT status FROM public.client_portal_accounts WHERE contact_id = $1`, [CONTACT]);
    expect(statuses.map((s) => s.status)).toEqual(['deactivated', 'deactivated']);
  });

  it('still answers with a generic error when the release itself fails', async () => {
    const d = deps({
      finish: async () => { throw new Error('db down'); },
      release: async () => { throw new Error('release down'); },
    });
    const res = await call(d, request({ contact_id: CONTACT }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The contact could not be deleted. Try again.' });
    expect(d.logs).toContain('release failed');
  });

  it('a failed audit write does not undo a completed delete', async () => {
    const d = deps({ audit: async () => { throw new Error('audit down'); } });
    const res = await call(d, request({ contact_id: CONTACT }));
    expect(res.status).toBe(200);
    expect(d.logs).toContain('audit failed');
  });

  it('removes a sign-in the final delete reports that was never destroyed', async () => {
    const deleted: string[] = [];
    const base = deps();
    const d = deps({
      begin: async (id) => ({ ...(await base.begin(id)), user_ids: [USER_A] }),
      deleteAuthUser: async (userId) => {
        deleted.push(userId);
        return base.deleteAuthUser(userId);
      },
    });
    expect((await call(d, request({ contact_id: CONTACT }))).status).toBe(200);
    expect(deleted.sort()).toEqual([USER_A, USER_B].sort());
  });

  it('records a sign-in it could not remove after the rows were deleted', async () => {
    const base = deps();
    const d = deps({
      begin: async (id) => ({ ...(await base.begin(id)), user_ids: [USER_A] }),
      deleteAuthUser: async (userId) => {
        if (userId === USER_B) throw new Error('auth down');
        return base.deleteAuthUser(userId);
      },
    });
    expect((await call(d, request({ contact_id: CONTACT }))).status).toBe(200);
    const [audit] = await rows<{ details: { orphaned_sign_ins: string[] } }>(
      `SELECT details FROM public.audit_logs WHERE action = 'contact_deleted'`,
    );
    expect(audit.details.orphaned_sign_ins).toEqual([USER_B]);
  });
});
