// @vitest-environment node
// invite-client-portal against the real migrations in PGlite: the account and the
// invitation land together or not at all, addresses compare case-insensitively, the
// daily cap holds, the link carries the token in its fragment, and the audit row holds
// ids and codes only.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore } from '../db/harness';
import {
  createInviteHandler,
  type InviteAuditEntry,
  type InviteDeps,
  type SendInviteInput,
} from '../../../supabase/functions/invite-client-portal/handler';
import { inviteContent, inviteSubject } from '../../../supabase/functions/invite-client-portal/invite-email';
import { renderEmail } from '../../../supabase/functions/_shared/email-layout';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

let db: PGlite;
let contactId: string;
let n = 0;
let primary: string;
let spouse: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

function deps(over: Partial<InviteDeps> = {}) {
  const sent: SendInviteInput[] = [];
  const audits: InviteAuditEntry[] = [];
  const server = serviceClient(db);
  const d: InviteDeps = {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: 'https://crm.example.com',
    authorizeOwner: fakeOwnerAuth(),
    async loadContact(id) {
      const [row] = await rows<{ id: string; first_name: string | null; spouse_first_name: string | null; email: string | null }>(
        `SELECT id, first_name, spouse_first_name, email FROM public.contacts WHERE id = $1`, [id]);
      return row ?? null;
    },
    contactEmails: (id) => rows(`SELECT email, kind FROM public.contact_emails WHERE contact_id = $1`, [id]),
    async createInvitation({ contactId: c, email, tokenHash, expiresAt }) {
      const { data, error } = await server.rpc('create_portal_invitation', {
        p_contact_id: c, p_email: email, p_token_hash: tokenHash, p_expires_at: expiresAt.toISOString(), p_invited_by: null,
      });
      if (error) throw error;
      return data as string;
    },
    async sendInvite(input) {
      sent.push(input);
      return { status: 'sent', channel: 'local', id: null };
    },
    async audit(entry) {
      audits.push(entry);
    },
    logSink: () => {},
    ...over,
  };
  return { d, sent, audits };
}

const invite = (d: InviteDeps, body: Record<string, unknown>) =>
  createInviteHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

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
  name: 'invite-client-portal',
  handler: async (req) => createInviteHandler(deps().d)(req),
  failingHandler: async (req) => createInviteHandler(deps({ loadContact: throwInternal }).d)(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { contact_id: '10000000-0000-4000-8000-000000000999' }, maxBytes: 2048 },
});

describe('invite-client-portal', () => {
  it('opens the account and the invitation, and the link carries the token whose hash is stored', async () => {
    const { d, sent, audits } = deps();
    const res = await invite(d, { contact_id: contactId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inviteUrl: string; emailSent: boolean; delivery: string };
    expect(body).toMatchObject({ emailSent: true, delivery: 'sent' });
    const match = /^https:\/\/crm\.example\.com\/invite#token=([A-Za-z0-9_-]{43})$/.exec(body.inviteUrl);
    expect(match).not.toBeNull();
    const [inv] = await rows<{ token_hash: string; email: string }>(`SELECT token_hash, email FROM public.portal_invitations WHERE contact_id = $1`, [contactId]);
    expect(inv).toEqual({ token_hash: await sha256Hex(match![1]), email: primary });
    expect(sent).toEqual([expect.objectContaining({ to: primary, firstName: 'Ada', variant: 'initial', url: body.inviteUrl })]);
    expect(audits).toEqual([
      expect.objectContaining({
        ownerId: OWNER_ID,
        action: 'portal_invite_sent',
        details: { contact_id: contactId, invitation_id: expect.any(String), email_kind: 'primary', delivery: 'sent' },
      }),
    ]);
  });

  it("invites the spouse's address and greets the spouse", async () => {
    const { d, sent } = deps();
    expect((await invite(d, { contact_id: contactId, email: spouse.toUpperCase() })).status).toBe(200);
    expect(sent[0]).toMatchObject({ to: spouse, firstName: 'Grace' });
  });

  it('refuses a second open invitation to the same address in any case, leaving no orphan', async () => {
    const { d } = deps();
    await invite(d, { contact_id: contactId });
    await db.query(`UPDATE public.contact_emails SET email = upper(email) WHERE contact_id = $1 AND kind = 'primary'`, [contactId]);
    const res = await invite(d, { contact_id: contactId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'already_invited' });
    expect(await rows(`SELECT 1 FROM public.portal_invitations WHERE contact_id = $1`, [contactId])).toHaveLength(1);
  });

  it("refuses an address that is not the contact's", async () => {
    const { d, sent } = deps();
    const res = await invite(d, { contact_id: contactId, email: 'someone@example.net' });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('holds three invitations a day per contact', async () => {
    await db.query(
      `INSERT INTO public.portal_invitations (email, contact_id, status, expires_at) SELECT 'old@example.com', $1, 'revoked', now() FROM generate_series(1, 3)`,
      [contactId]);
    const { d, sent } = deps();
    const res = await invite(d, { contact_id: contactId });
    expect(res.status).toBe(429);
    expect(sent).toEqual([]);
  });

  it('a failed or impossible send still answers with the link for the owner to deliver', async () => {
    const failed = deps({ sendInvite: async () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 }) });
    const res = await invite(failed.d, { contact_id: contactId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ emailSent: false, delivery: 'failed', inviteUrl: expect.stringContaining('#token=') });
    const thrown = deps({ sendInvite: async () => { throw new Error('Email is not configured'); } });
    expect(await (await invite(thrown.d, { contact_id: contactId, email: spouse })).json()).toMatchObject({ emailSent: false, delivery: 'failed' });
  });

  it('a contact that does not exist is 404; a server with no SITE_URL refuses before writing', async () => {
    const { d } = deps();
    expect((await invite(d, { contact_id: '10000000-0000-4000-8000-000000000999' })).status).toBe(404);
    const noSite = deps({ siteUrl: null });
    expect((await invite(noSite.d, { contact_id: contactId })).status).toBe(500);
    expect(await rows(`SELECT 1 FROM public.portal_invitations WHERE contact_id = $1`, [contactId])).toHaveLength(0);
  });
});

describe('the invitation email', () => {
  const org = { displayName: 'Acme LLC', legalName: null, senderName: 'Acme LLC', postalAddress: null, logoUrl: null, brandColor: null };

  it('names the organization, escapes the name, links the button and states the expiry in UTC', () => {
    const content = inviteContent({ org, variant: 'initial', firstName: '<b>Ada</b>', url: 'https://crm.example.com/invite#token=x', expiresAt: new Date('2026-05-08T15:04:00Z') });
    const { html, text } = renderEmail(org, content);
    expect(html).toContain('Welcome, &lt;b&gt;Ada&lt;/b&gt;');
    expect(html).toContain('href="https://crm.example.com/invite#token=x"');
    expect(text).toContain('Friday, May 8, 2026 at 3:04 PM UTC');
    expect(inviteSubject(org, 'initial')).toBe('Your client portal invitation from Acme LLC');
    expect(inviteSubject(org, 'resend')).toBe('A new portal invitation from Acme LLC');
  });
});
