// @vitest-environment node
// revoke-portal-access against the real migrations in PGlite: one account deactivated,
// its pending link revoked, its sign-in banned, and the audit row written even when the
// ban fails.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import { createRevokeHandler, type RevokeDeps } from '../../../supabase/functions/revoke-portal-access/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let accountId: string;
let userId: string;
let n = 0;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

function deps(over: Partial<RevokeDeps> = {}) {
  const banned: string[] = [];
  const audits: unknown[] = [];
  const server = serviceClient(db);
  const d: RevokeDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    async accountContact(id) {
      const [row] = await rows<{ contact_id: string }>(`SELECT contact_id FROM public.client_portal_accounts WHERE id = $1`, [id]);
      return row?.contact_id ?? null;
    },
    async deactivate(id) {
      const { data, error } = await server.rpc('deactivate_portal_account', { p_account_id: id });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    async expireStartLinks(id) {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await tx.query(`UPDATE public.pending_signup_requests SET status = 'expired' WHERE contact_id = $1 AND status = 'pending'`, [id]);
      });
    },
    async banUser(id) {
      banned.push(id);
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, banned, audits };
}

const revoke = (d: RevokeDeps, id: string) => createRevokeHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body: { account_id: id } }));

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  const email = `ada-${n}@example.com`;
  contactId = await seedContact(db, { email });
  await db.query(`SELECT public.create_portal_invitation($1, $2, $3, now() + interval '7 days', NULL)`, [contactId, email, randomUUID()]);
  userId = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, email]);
  [{ id: accountId }] = await rows<{ id: string }>(
    `UPDATE public.client_portal_accounts SET user_id = $1, status = 'active' WHERE contact_id = $2 RETURNING id`, [userId, contactId]);
});

describeEdgeContract({
  name: 'revoke-portal-access',
  handler: async (req) => createRevokeHandler(deps().d)(req),
  failingHandler: async (req) => createRevokeHandler(deps({ accountContact: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { account_id: '10000000-0000-4000-8000-000000000999' }, maxBytes: 1024 },
});

describe('revoke-portal-access', () => {
  it('deactivates the account, revokes its pending link and bans its sign-in', async () => {
    const { d, banned, audits } = deps();
    expect((await revoke(d, accountId)).status).toBe(200);
    expect((await rows<{ status: string }>(`SELECT status FROM public.client_portal_accounts WHERE id = $1`, [accountId]))[0].status).toBe('deactivated');
    expect((await rows<{ status: string }>(`SELECT status FROM public.portal_invitations WHERE contact_id = $1`, [contactId])).map((r) => r.status)).toEqual(['revoked']);
    expect(banned).toEqual([userId]);
    expect(audits).toEqual([expect.objectContaining({ action: 'portal_access_deactivated', details: { contact_id: contactId, account_id: accountId, sign_in_blocked: true } })]);
  });

  it('a failed ban is recorded, then reported; a retry finishes the job', async () => {
    const failing = deps({ banUser: async () => { throw new Error('auth down'); } });
    const res = await revoke(failing.d, accountId);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'ban_failed' });
    expect(failing.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ sign_in_blocked: false }) })]);
    const retry = deps();
    expect((await revoke(retry.d, accountId)).status).toBe(200);
    expect(retry.banned).toEqual([userId]);
  });

  it("expires the contact's pending start links before the ban, and they were refused already", async () => {
    const [{ id: listId }] = await rows<{ id: string }>(
      `INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Docs', 'sent', now()) RETURNING id`, [contactId]);
    const [{ id: linkId }] = await rows<{ id: string }>(
      `INSERT INTO public.pending_signup_requests (email, contact_id, needs_list_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days') RETURNING id`,
      [`ada-${n}@example.com`, contactId, listId, n.toString(16).padStart(64, '0')]);
    const order: string[] = [];
    const base = deps();
    const { d } = deps({
      async expireStartLinks(id) {
        await base.d.expireStartLinks(id);
        // Pushed after the write lands: a ban that did not wait for it comes first.
        order.push('expire');
      },
      async banUser() {
        order.push('ban');
        const [{ status }] = await rows<{ status: string }>(`SELECT status FROM public.pending_signup_requests WHERE id = $1`, [linkId]);
        expect(status).toBe('expired');
      },
    });
    expect((await revoke(d, accountId)).status).toBe(200);
    expect(order).toEqual(['expire', 'ban']);
    const [{ revoked }] = await rows<{ revoked: boolean }>(
      `SELECT public.start_link_access_revoked($1, $2, $3) AS revoked`, [contactId, `ada-${n}@example.com`, listId]);
    expect(revoked).toBe(true);
  });

  it('a failed expiry is logged and the sign-in is still banned', async () => {
    const logs: string[] = [];
    const { d, banned } = deps({ expireStartLinks: async () => { throw new Error('links down'); }, logSink: (_level, line) => logs.push(line) });
    expect((await revoke(d, accountId)).status).toBe(200);
    expect(banned).toEqual([userId]);
    expect(logs).toContainEqual(expect.stringMatching(/start link expiry failed after deactivating: links down$/));
  });

  it('a missing account is 404', async () => {
    expect((await revoke(deps().d, randomUUID())).status).toBe(404);
  });
});
