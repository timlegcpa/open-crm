// @vitest-environment node
// resend-portal-invite against the real migrations in PGlite: one account at a time, the
// cap checked before anything is deleted, and a deactivated account's old sign-in removed
// so the new acceptance does not collide with it.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import { createResendHandler, type PortalAccountRow, type ResendDeps } from '../../../supabase/functions/resend-portal-invite/handler';
import type { SendInviteInput } from '../../../supabase/functions/invite-client-portal/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let primary: string;
let spouse: string;
let n = 0;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function openInvite(email: string): Promise<string> {
  await db.query(`SELECT public.create_portal_invitation($1, $2, $3, now() + interval '7 days', NULL)`, [contactId, email, randomUUID()]);
  const [row] = await rows<{ id: string }>(`SELECT id FROM public.client_portal_accounts WHERE contact_id = $1 AND invited_email = $2`, [contactId, email]);
  return row.id;
}

function deps(over: Partial<ResendDeps> = {}) {
  const calls: string[] = [];
  const sent: SendInviteInput[] = [];
  const server = serviceClient(db);
  const d: ResendDeps = {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: 'https://crm.example.com',
    authorizeOwner: fakeOwnerAuth(),
    async loadAccount(id) {
      const [row] = await rows<PortalAccountRow>(`SELECT id, contact_id, user_id, status, invited_email FROM public.client_portal_accounts WHERE id = $1`, [id]);
      return row ?? null;
    },
    async throttled(c) {
      calls.push('throttle');
      const { data } = await server.rpc('portal_invite_throttled', { p_contact_id: c });
      return data === true;
    },
    async deleteAuthUser(id) {
      calls.push('delete');
      await db.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
    },
    async reissue({ accountId, tokenHash, expiresAt }) {
      calls.push('reissue');
      const [row] = await rows<{ invitation_id: string; contact_id: string; email: string }>(
        `SELECT * FROM public.reissue_portal_invitation($1, $2, $3, NULL)`, [accountId, tokenHash, expiresAt.toISOString()]);
      return { invitationId: row.invitation_id, contactId: row.contact_id, email: row.email };
    },
    async loadGreeting(c) {
      const [row] = await rows<{ first_name: string; spouse_first_name: string; spouse_email: string }>(
        `SELECT first_name, spouse_first_name, spouse_email FROM public.contacts WHERE id = $1`, [c]);
      return row ?? null;
    },
    async sendInvite(input) {
      sent.push(input);
      return { status: 'sent', channel: 'local', id: null };
    },
    audit: async () => {},
    logSink: () => {},
    ...over,
  };
  return { d, calls, sent };
}

const resend = (d: ResendDeps, accountId: string) =>
  createResendHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body: { account_id: accountId } }));

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  primary = `ada-${n}@example.com`;
  spouse = `grace-${n}@example.com`;
  contactId = await seedContact(db, { email: primary, spouse_first_name: 'Grace', spouse_email: spouse });
});

describeEdgeContract({
  name: 'resend-portal-invite',
  handler: async (req) => createResendHandler(deps().d)(req),
  failingHandler: async (req) => createResendHandler(deps({ loadAccount: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { account_id: '10000000-0000-4000-8000-000000000999' }, maxBytes: 1024 },
});

describe('resend-portal-invite', () => {
  it("re-sends one account's link and leaves the other person's account and link alone", async () => {
    const mine = await openInvite(primary);
    await openInvite(spouse);
    const { d, sent } = deps();
    expect((await resend(d, mine)).status).toBe(200);
    const links = await rows<{ email: string; status: string }>(`SELECT email, status FROM public.portal_invitations WHERE contact_id = $1 ORDER BY created_at, id`, [contactId]);
    expect(links).toEqual([
      { email: primary, status: 'revoked' },
      { email: spouse, status: 'pending' },
      { email: primary, status: 'pending' },
    ]);
    expect(sent[0]).toMatchObject({ to: primary, firstName: 'Ada', variant: 'resend' });
  });

  it("greets the spouse on the spouse's account", async () => {
    const theirs = await openInvite(spouse);
    const { d, sent } = deps();
    await resend(d, theirs);
    expect(sent[0]).toMatchObject({ to: spouse, firstName: 'Grace' });
  });

  it('re-invites a deactivated account: its old sign-in goes first, after the cap check', async () => {
    const account = await openInvite(primary);
    const user = randomUUID();
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, primary]);
    await db.query(`UPDATE public.client_portal_accounts SET user_id = $1, status = 'deactivated' WHERE id = $2`, [user, account]);
    const { d, calls } = deps();
    expect((await resend(d, account)).status).toBe(200);
    expect(calls).toEqual(['throttle', 'delete', 'reissue']);
    const [row] = await rows<{ status: string; user_id: string | null }>(`SELECT status, user_id FROM public.client_portal_accounts WHERE id = $1`, [account]);
    expect(row).toEqual({ status: 'invited', user_id: null });
  });

  it('at the cap, refuses before deleting anything', async () => {
    const account = await openInvite(primary);
    const user = randomUUID();
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [user, primary]);
    await db.query(`UPDATE public.client_portal_accounts SET user_id = $1, status = 'deactivated' WHERE id = $2`, [user, account]);
    await db.query(
      `INSERT INTO public.portal_invitations (email, contact_id, status, expires_at) SELECT 'old@example.com', $1, 'revoked', now() FROM generate_series(1, 2)`,
      [contactId]);
    const { d, calls, sent } = deps();
    expect((await resend(d, account)).status).toBe(429);
    expect(calls).toEqual(['throttle']);
    expect(sent).toEqual([]);
    expect(await rows(`SELECT 1 FROM auth.users WHERE id = $1`, [user])).toHaveLength(1);
  });

  it('refuses an active account, and a missing one', async () => {
    const account = await openInvite(primary);
    await db.query(`UPDATE public.client_portal_accounts SET status = 'active' WHERE id = $1`, [account]);
    const { d, calls } = deps();
    expect((await resend(d, account)).status).toBe(409);
    expect((await resend(d, randomUUID())).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
