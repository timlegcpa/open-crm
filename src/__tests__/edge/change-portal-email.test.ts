// @vitest-environment node
// change-portal-email against the real migrations in PGlite: Auth first, then the record;
// a refusal at either check or at Auth changes nothing; a record that moved under the
// change is reported as half done and recorded, and a retry finishes it.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import {
  createChangePortalEmailHandler,
  type ChangeEmailDeps,
  type CheckOutcome,
  type SetOutcome,
} from '../../../supabase/functions/change-portal-email/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let accountId: string;
let userId: string;
let email: string;
let n = 0;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

function deps(over: Partial<ChangeEmailDeps> = {}) {
  const signIns: Array<{ userId: string; email: string }> = [];
  const audits: unknown[] = [];
  const server = serviceClient(db);
  const d: ChangeEmailDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    async check(id, next, expected) {
      const { data, error } = await server.rpc('portal_login_for_change', { p_account_id: id, p_email: next, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: CheckOutcome; user_id?: string };
    },
    async setSignInEmail(id, next) {
      signIns.push({ userId: id, email: next });
      return 'changed';
    },
    async setRecord(id, next, expected) {
      const { data, error } = await server.rpc('portal_set_login_email', { p_account_id: id, p_email: next, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: SetOutcome; contact_id?: string; contact_address?: string };
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, signIns, audits };
}

const change = (d: ChangeEmailDeps, body: Record<string, unknown>) =>
  createChangePortalEmailHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

const stored = async () =>
  (await rows<{ invited_email: string; email: string }>(
    `SELECT a.invited_email, c.email FROM public.client_portal_accounts a JOIN public.contacts c ON c.id = a.contact_id WHERE a.id = $1`, [accountId]))[0];

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  email = `ada-${n}@example.com`;
  contactId = await seedContact(db, { email });
  userId = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, email]);
  [{ id: accountId }] = await rows<{ id: string }>(
    `INSERT INTO public.client_portal_accounts (contact_id, user_id, status, invited_email) VALUES ($1, $2, 'active', $3) RETURNING id`,
    [contactId, userId, email]);
});

describeEdgeContract({
  name: 'change-portal-email',
  handler: async (req) => createChangePortalEmailHandler(deps().d)(req),
  failingHandler: async (req) => createChangePortalEmailHandler(deps({ check: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: {
    kind: 'json',
    valid: { account_id: '10000000-0000-4000-8000-000000000999', email: 'new@example.com', expected_email: 'old@example.com' },
    maxBytes: 2048,
  },
});

describe('change-portal-email', () => {
  it('moves the sign-in first, then the account and the contact address, audited without an address', async () => {
    const { d, signIns, audits } = deps();
    const res = await change(d, { account_id: accountId, email: ` Ada.New-${n}@example.com `, expected_email: email.toUpperCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, contact_address: 'email' });
    expect(signIns).toEqual([{ userId, email: `Ada.New-${n}@example.com` }]);
    expect(await stored()).toEqual({ invited_email: `Ada.New-${n}@example.com`, email: `Ada.New-${n}@example.com` });
    expect(audits).toEqual([expect.objectContaining({
      action: 'portal_login_email_changed', details: { contact_id: contactId, account_id: accountId, outcome: 'updated' },
    })]);
    expect(JSON.stringify(audits)).not.toMatch(/@/);
  });

  it('a stale read, an account with no sign-in, an address in use and a bad address never reach Auth', async () => {
    const { d, signIns } = deps();
    expect((await change(d, { account_id: accountId, email: 'x@example.com', expected_email: 'someone@example.com' })).status).toBe(409);
    const [{ id: invited }] = await rows<{ id: string }>(
      `INSERT INTO public.client_portal_accounts (contact_id, status, invited_email, role) VALUES ($1, 'invited', $2, 'secondary') RETURNING id`,
      [contactId, `pending-${n}@example.com`]);
    const noSignIn = await change(d, { account_id: invited, email: 'x@example.com', expected_email: `pending-${n}@example.com` });
    expect(await noSignIn.json()).toMatchObject({ code: 'no_sign_in' });
    const inUse = await change(d, { account_id: accountId, email: `pending-${n}@example.com`, expected_email: email });
    expect(await inUse.json()).toMatchObject({ code: 'address_in_use' });
    expect((await change(d, { account_id: accountId, email: 'not-an-address', expected_email: email })).status).toBe(400);
    expect((await change(d, { account_id: randomUUID(), email: 'x@example.com', expected_email: null })).status).toBe(404);
    expect(signIns).toEqual([]);
    expect(await stored()).toEqual({ invited_email: email, email });
  });

  it('a refusal from Auth changes nothing', async () => {
    const { d } = deps({ setSignInEmail: async () => 'refused' });
    const res = await change(d, { account_id: accountId, email: 'taken@example.com', expected_email: email });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'auth_refused' });
    expect(await stored()).toEqual({ invited_email: email, email });
  });

  it('a record that moved after the check is reported as half done and recorded; a retry finishes it', async () => {
    const racing = deps({
      async setSignInEmail() {
        await db.query(`UPDATE public.client_portal_accounts SET invited_email = 'moved@example.com' WHERE id = $1`, [accountId]);
        return 'changed';
      },
    });
    const res = await change(racing.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'partial_change' });
    expect(racing.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ outcome: 'stale' }) })]);

    const thrown = deps({ setRecord: throwInternal });
    const broken = await change(thrown.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: 'moved@example.com' });
    expect(await broken.json()).toMatchObject({ code: 'partial_change' });
    expect(thrown.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ outcome: 'error' }) })]);

    const retry = deps();
    expect((await change(retry.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: 'moved@example.com' })).status).toBe(200);
    expect((await stored()).invited_email).toBe(`next-${n}@example.com`);
  });
});
