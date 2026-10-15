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

  it('a missing account is 404', async () => {
    expect((await revoke(deps().d, randomUUID())).status).toBe(404);
  });
});
