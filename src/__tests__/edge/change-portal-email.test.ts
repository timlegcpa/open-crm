// @vitest-environment node
// change-portal-email against the real migrations in PGlite, with one fake Auth that every
// request in a test shares (so two interleaved requests see each other's sign-in changes):
//   * Auth first, then the record; a refusal at any check or at Auth changes nothing;
//   * Auth's own address must be the one the screen read (or already the new one);
//   * an Auth call with no clear answer, and a record that could not follow, are answered as
//     such and audited, and both are finished by editing from the address the record shows;
//   * the old address is told, and a notice that fails never undoes the change.
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
import { signInChangedContent, signInChangedSubject } from '../../../supabase/functions/change-portal-email/notice';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let accountId: string;
let userId: string;
let email: string;
let n = 0;
/** The fake Auth: each sign-in user's address. */
const authEmails = new Map<string, string>();

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

function deps(over: Partial<ChangeEmailDeps> = {}) {
  const signIns: Array<{ userId: string; email: string }> = [];
  const notices: Array<{ to: string; accountId: string }> = [];
  const audits: Array<{ action: string; details: Record<string, string> }> = [];
  const server = serviceClient(db);
  const d: ChangeEmailDeps = {
    allowedOrigins: ['http://localhost:5173'],
    authorizeOwner: fakeOwnerAuth(),
    async check(id, next, expected) {
      const { data, error } = await server.rpc('portal_login_for_change', { p_account_id: id, p_email: next, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: CheckOutcome; user_id?: string; contact_id?: string };
    },
    async currentSignInEmail(id) {
      return authEmails.get(id) ?? null;
    },
    async setSignInEmail(id, next) {
      signIns.push({ userId: id, email: next });
      authEmails.set(id, next);
      return 'changed';
    },
    async setRecord(id, next, expected) {
      const { data, error } = await server.rpc('portal_set_login_email', { p_account_id: id, p_email: next, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: SetOutcome; contact_id?: string; contact_address?: string };
    },
    async sendNotice({ to, accountId: account }) {
      notices.push({ to, accountId: account });
      return 'sent';
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, signIns, notices, audits };
}

const change = (d: ChangeEmailDeps, body: Record<string, unknown>) =>
  createChangePortalEmailHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

/** What the record shows (the account and the contact) and what Auth holds. */
const stored = async () => ({
  ...(await rows<{ invited_email: string; email: string }>(
    `SELECT a.invited_email, c.email FROM public.client_portal_accounts a JOIN public.contacts c ON c.id = a.contact_id WHERE a.id = $1`, [accountId]))[0],
  auth: authEmails.get(userId),
});

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
  authEmails.set(userId, email);
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
  it('moves the sign-in first, then the account and the contact address, tells the old address, audited without an address', async () => {
    const { d, signIns, notices, audits } = deps();
    const res = await change(d, { account_id: accountId, email: ` Ada.New-${n}@example.com `, expected_email: email.toUpperCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, contact_address: 'email', notice: 'sent' });
    expect(signIns).toEqual([{ userId, email: `Ada.New-${n}@example.com` }]);
    expect(await stored()).toEqual({ invited_email: `Ada.New-${n}@example.com`, email: `Ada.New-${n}@example.com`, auth: `Ada.New-${n}@example.com` });
    expect(notices).toEqual([{ to: email, accountId }]);
    expect(audits).toEqual([expect.objectContaining({
      action: 'portal_login_email_changed', details: { contact_id: contactId, account_id: accountId, outcome: 'updated', notice: 'sent' },
    })]);
    expect(JSON.stringify(audits)).not.toMatch(/@/);
  });

  it('the notice tells the old inbox the sign-in changed, never the new address', () => {
    const org = { displayName: 'Example Co', legalName: null, senderName: 'Example Co', postalAddress: null, logoUrl: null, brandColor: null };
    const content = JSON.stringify(signInChangedContent(org));
    expect(signInChangedSubject(org)).toBe('Your Example Co portal sign-in email was changed');
    expect(content).toMatch(/did not ask for this change/);
    expect(content).not.toMatch(/@/);
  });

  it('a notice that cannot be sent never undoes the change, and is recorded', async () => {
    const { d, audits } = deps({ sendNotice: throwInternal });
    const res = await change(d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, notice: 'error' });
    expect((await stored()).invited_email).toBe(`next-${n}@example.com`);
    expect(audits[0].details).toMatchObject({ outcome: 'updated', notice: 'error' });
  });

  it('a stale read, an account with no sign-in, an address in use and a bad address never reach Auth', async () => {
    const { d, signIns, notices } = deps();
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
    expect(notices).toEqual([]);
    expect(await stored()).toEqual({ invited_email: email, email, auth: email });
  });

  it('refuses as stale, before Auth is touched, when Auth holds another address than the one the screen read', async () => {
    authEmails.set(userId, 'elsewhere@example.com');
    const { d, signIns } = deps();
    const res = await change(d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('stale');
    expect(body.error).toMatch(/Reopen the record and edit from the address it shows now/);
    expect(signIns).toEqual([]);
    expect((await stored()).invited_email).toBe(email);
  });

  it('a refusal from Auth changes nothing', async () => {
    const { d } = deps({ setSignInEmail: async () => 'refused' });
    const res = await change(d, { account_id: accountId, email: 'taken@example.com', expected_email: email });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'auth_refused' });
    expect(await stored()).toEqual({ invited_email: email, email, auth: email });
  });

  it('an Auth call with no clear answer is said and audited, not a generic error; editing from the shown address finishes it', async () => {
    // Auth took the change and then the answer was lost.
    const lost = deps({
      async setSignInEmail(id, next) {
        authEmails.set(id, next);
        throw new Error('socket hang up');
      },
    });
    const res = await change(lost.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'sign_in_unknown', error: expect.stringMatching(/may or may not have happened\. Reopen the record/) });
    expect(lost.audits).toEqual([expect.objectContaining({ details: { contact_id: contactId, account_id: accountId, outcome: 'auth_unknown' } })]);
    expect(await stored()).toEqual({ invited_email: email, email, auth: `next-${n}@example.com` });

    // The record still shows the old address; editing from it to the new one finishes the job.
    const again = deps();
    expect((await change(again.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email })).status).toBe(200);
    expect(again.signIns).toEqual([]);
    expect(again.notices).toEqual([{ to: email, accountId }]);
    expect(await stored()).toEqual({ invited_email: `next-${n}@example.com`, email: `next-${n}@example.com`, auth: `next-${n}@example.com` });
  });

  it('a database half that throws after Auth moved is a partial change, audited; editing from the shown address finishes it', async () => {
    const broken = deps({ setRecord: throwInternal });
    const res = await change(broken.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'partial_change', error: expect.stringMatching(/Reopen the record and edit from the address it shows now/) });
    expect(broken.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ outcome: 'partial_error' }) })]);
    expect(broken.notices).toEqual([]);

    const finish = deps();
    expect((await change(finish.d, { account_id: accountId, email: `next-${n}@example.com`, expected_email: email })).status).toBe(200);
    expect(await stored()).toEqual({ invited_email: `next-${n}@example.com`, email: `next-${n}@example.com`, auth: `next-${n}@example.com` });
  });

  it('A to B, then A to C from the same stale screen: the second is refused as stale', async () => {
    const b = `b-${n}@example.com`;
    const c = `c-${n}@example.com`;
    expect((await change(deps().d, { account_id: accountId, email: b, expected_email: email })).status).toBe(200);
    const second = deps();
    const res = await change(second.d, { account_id: accountId, email: c, expected_email: email });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'stale' });
    expect(second.signIns).toEqual([]);
    expect(await stored()).toEqual({ invited_email: b, email: b, auth: b });
  });

  it('A to B and A to C interleaved: one lands, the other is half done and said so; editing from the shown address recovers', async () => {
    const b = `b-${n}@example.com`;
    const c = `c-${n}@example.com`;
    let first: Response | undefined;
    // The A to C request passes both checks, then the whole A to B request runs before its
    // Auth call lands: the interleaving the Auth read alone cannot close.
    const second = deps({
      async setSignInEmail(id, next) {
        first = await change(deps().d, { account_id: accountId, email: b, expected_email: email });
        authEmails.set(id, next);
        return 'changed';
      },
    });
    const res = await change(second.d, { account_id: accountId, email: c, expected_email: email });
    expect(first?.status).toBe(200);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'partial_change' });
    expect(second.audits).toEqual([expect.objectContaining({ details: expect.objectContaining({ outcome: 'partial_stale' }) })]);
    expect(await stored()).toEqual({ invited_email: b, email: b, auth: c });

    // The record shows B. Editing B to C finishes the move Auth already made.
    const recover = deps();
    expect((await change(recover.d, { account_id: accountId, email: c, expected_email: b })).status).toBe(200);
    expect(await stored()).toEqual({ invited_email: c, email: c, auth: c });
  });
});
