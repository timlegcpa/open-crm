// @vitest-environment node
// send-needs-list against the real migrations in PGlite. Only the mail is faked, and it
// records every message, so each path is checked by what it published, linked and sent.
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore, seedPortalAccount } from '../db/harness';
import {
  createSendNeedsListHandler,
  type NeedsSendStore,
  type SendNeedsDeps,
} from '../../../supabase/functions/send-needs-list/handler';
import type { SendResult } from '../../../supabase/functions/_shared/outbound';
import type { OrgIdentity } from '../../../supabase/functions/_shared/organization';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';

const SITE = 'https://crm.example.com';
const TOKEN = 'S'.repeat(43);
const ORG: OrgIdentity = {
  displayName: 'Example Co', legalName: null, senderName: 'Example Co', postalAddress: null, logoUrl: null, brandColor: null,
};

interface Sent {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

let db: PGlite;
let withAccount: string;
let noAccount: string;
let noEmail: string;
let n = 0;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

/** The store over PGlite as the server: the same functions index.ts calls through supabase-js. */
function pgliteStore(sent: Sent[], status: () => SendResult = () => ({ status: 'sent', channel: 'local', id: null })): NeedsSendStore {
  return {
    async loadList(id) {
      const [row] = await q<never>(
        `SELECT id, contact_id, title, intro_message, status, content_version, reminder_count FROM public.needs_lists WHERE id = $1`, [id]);
      return row ?? null;
    },
    async loadContact(id) {
      const [row] = await q<never>(`SELECT first_name, email FROM public.contacts WHERE id = $1`, [id]);
      return row ?? null;
    },
    async countItems(id) {
      return (await q<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_items WHERE list_id = $1`, [id]))[0].n;
    },
    async progress(id) {
      const [row] = await q<never>(`SELECT actionable, fulfilled, required_open FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [id]);
      return row ?? { actionable: 0, fulfilled: 0, required_open: 0 };
    },
    async hasActivePortalAccount(contactId) {
      return (await q(`SELECT 1 FROM public.client_portal_accounts WHERE contact_id = $1 AND status = 'active' AND user_id IS NOT NULL`, [contactId])).length > 0;
    },
    async issueStartLink({ listId, email, tokenHash, expiresAt, actorId, supersede }) {
      return (await q<{ id: string }>(`SELECT public.needs_issue_start_link($1, $2, $3, $4, $5, $6) AS id`,
        [listId, email, tokenHash, expiresAt.toISOString(), actorId, supersede]))[0].id;
    },
    async expireStartLink(id) {
      await q(`SELECT public.expire_start_link($1)`, [id]);
    },
    async sendList(id, v) {
      return (await q<{ r: never }>(`SELECT public.needs_send_list($1, $2) AS r`, [id, v]))[0].r;
    },
    async recordReminder(id) {
      return (await q<{ r: boolean }>(`SELECT public.needs_record_reminder($1) AS r`, [id]))[0].r;
    },
    loadOrg: async () => ORG,
    async sendEmail({ to, subject, content, idempotencyKey }) {
      const text = content.blocks.map((b) => ('text' in b ? b.text : 'url' in b ? `${b.label} ${b.url}` : b.items.join(' '))).join('\n');
      sent.push({ to, subject, text, idempotencyKey });
      return status();
    },
    newToken: () => TOKEN,
  };
}

function deps(sent: Sent[], over: Partial<SendNeedsDeps> = {}, status?: () => SendResult): SendNeedsDeps {
  return {
    ...pgliteStore(sent, status),
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: SITE,
    authorizeOwner: fakeOwnerAuth(),
    async audit(entry) {
      await q(`INSERT INTO public.audit_logs (user_id, action, details) VALUES ($1, $2, $3)`,
        [entry.actorId ?? '00000000-0000-4000-8000-000000000002', entry.action, JSON.stringify(entry.details ?? {})]);
    },
    resolveActor: () => null,
    logSink: () => {},
    ...over,
  };
}

const call = (d: SendNeedsDeps, body: Record<string, unknown>) =>
  createSendNeedsListHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

async function draft(contactId: string, items = 2): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO public.needs_lists (contact_id, title, intro_message) VALUES ($1, 'Onboarding documents', 'Thanks!') RETURNING id`, [contactId]);
  for (let i = 0; i < items; i++) {
    await q(`INSERT INTO public.needs_items (list_id, kind, label, sort_order) VALUES ($1, $2, $3, $4)`,
      [row.id, i % 2 ? 'todo' : 'document', `Item ${i}`, i]);
  }
  return row.id;
}

const listRow = async (id: string) =>
  (await q<{ status: string; reminder_count: number; sent_at: string | null }>(
    `SELECT status, reminder_count, sent_at FROM public.needs_lists WHERE id = $1`, [id]))[0];
const links = (listId: string) =>
  q<{ token_hash: string; status: string; email: string; created_by: string | null }>(
    `SELECT token_hash, status, email, created_by FROM public.pending_signup_requests WHERE needs_list_id = $1 ORDER BY created_at, id`, [listId]);

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

beforeEach(async () => {
  n += 1;
  withAccount = await seedContact(db, { first_name: 'Ada', email: `ada-${n}@example.com` });
  await seedPortalAccount(db, withAccount, { email: `ada-${n}@example.com` });
  noAccount = await seedContact(db, { first_name: 'Grace', email: `Grace-${n}@Example.com` });
  noEmail = await seedContact(db, { first_name: 'Alan' });
  // One token for every test: earlier tests' links let go of it.
  await db.query(`DELETE FROM public.pending_signup_requests WHERE token_hash = $1`, [await sha256Hex(TOKEN)]);
});

describeEdgeContract({
  name: 'send-needs-list',
  handler: async (req) => createSendNeedsListHandler(deps([]))(req),
  failingHandler: async (req) => createSendNeedsListHandler(deps([], { loadList: throwInternal }))(req),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { list_id: '00000000-0000-4000-8000-00000000ffff' }, maxBytes: 1024 },
});

describe('send-needs-list: send', () => {
  it('publishes a draft to a contact with a portal account and emails the portal link', async () => {
    const sent: Sent[] = [];
    const id = await draft(withAccount);
    const res = await call(deps(sent), { list_id: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent', email_sent: true, start_link: false });
    expect((await listRow(id)).status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`ada-${n}@example.com`);
    expect(sent[0].subject).toBe('New request: Onboarding documents');
    expect(sent[0].text).toContain(`${SITE}/portal/requests/${id}`);
    expect(sent[0].text).toContain('2 items');
    expect(sent[0].idempotencyKey).toBe(`needs-send:${id}`);
    expect(await links(id)).toEqual([]);
    const audit = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM public.audit_logs WHERE action = 'needs_list_sent' AND details ->> 'list_id' = $1`, [id]);
    expect(audit[0].details).toEqual({ list_id: id, contact_id: withAccount, item_count: 2, start_link: false, email_status: 'sent' });
  });

  it('mints a start link for a contact without an account; only its hash is stored', async () => {
    const sent: Sent[] = [];
    const id = await draft(noAccount);
    const res = await call(deps(sent), { list_id: id });
    expect(await res.json()).toEqual({ status: 'sent', email_sent: true, start_link: true });
    expect(sent[0].text).toContain(`${SITE}/start#token=${TOKEN}`);
    const rows = await links(id);
    expect(rows).toEqual([{ token_hash: await sha256Hex(TOKEN), status: 'pending', email: `grace-${n}@example.com`, created_by: null }]);
  });

  it('records the actor the injected resolver names (the seam the AI connector uses)', async () => {
    const id = await draft(noAccount);
    const ownerId = (await q<{ id: string }>(`SELECT owner_user_id AS id FROM public.org_profile`))[0].id;
    await call(deps([], { resolveActor: () => ownerId }), { list_id: id });
    expect((await links(id))[0].created_by).toBe(ownerId);
  });

  it('publishes nothing when the content moved after it was read, and retires the unsent link', async () => {
    const sent: Sent[] = [];
    const id = await draft(noAccount);
    const d = deps(sent);
    const load = d.loadList;
    d.loadList = async (listId) => {
      const row = await load(listId);
      // An edit lands between the read and the publish.
      await q(`INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'Late edit')`, [listId]);
      return row;
    };
    const res = await call(d, { list_id: id });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('changed');
    expect((await listRow(id)).status).toBe('draft');
    expect(sent).toEqual([]);
    expect((await links(id)).map((r) => r.status)).toEqual(['expired']);
  });

  it('refuses a list already sent, an empty draft, a contact without an address, a missing list', async () => {
    const id = await draft(withAccount);
    await call(deps([]), { list_id: id });
    const again = await call(deps([]), { list_id: id });
    expect([again.status, (await again.json()).code]).toEqual([409, 'already_sent']);

    const empty = await draft(withAccount, 0);
    const res = await call(deps([]), { list_id: empty });
    expect([res.status, (await res.json()).code]).toEqual([400, 'no_items']);

    const silent = await draft(noEmail);
    const r2 = await call(deps([]), { list_id: silent });
    expect([r2.status, (await r2.json()).code]).toEqual([400, 'no_email']);
    expect((await listRow(silent)).status).toBe('draft');

    const r3 = await call(deps([]), { list_id: randomUUID() });
    expect(r3.status).toBe(404);
    const r4 = await call(deps([]), { list_id: 'not-a-uuid' });
    expect(r4.status).toBe(400);
  });

  it('a failed email does not undo the send; a lost answer reads as unknown', async () => {
    const id = await draft(withAccount);
    const failed = await call(deps([], {}, () => ({ status: 'failed', channel: 'resend', reason: 'provider_error', httpStatus: 500 })), { list_id: id });
    expect(await failed.json()).toEqual({ status: 'sent', email_sent: false, start_link: false });
    expect((await listRow(id)).status).toBe('sent');
    const id2 = await draft(withAccount);
    const unknown = await call(deps([], {}, () => ({ status: 'unknown', channel: 'resend' })), { list_id: id2 });
    expect((await unknown.json()).email_sent).toBeNull();
  });

  it('refuses to send without SITE_URL, before anything changes', async () => {
    const id = await draft(withAccount);
    const res = await call(deps([], { siteUrl: null }), { list_id: id });
    expect([res.status, (await res.json()).code]).toEqual([500, 'site_url_missing']);
    expect((await listRow(id)).status).toBe('draft');
  });
});

describe('send-needs-list: remind', () => {
  it('reminds with the open count, counts it, and keys the email by the count', async () => {
    const sent: Sent[] = [];
    const id = await draft(withAccount);
    await call(deps([]), { list_id: id });
    await q(`UPDATE public.needs_items SET status = 'fulfilled' WHERE list_id = $1 AND kind = 'todo'`, [id]);
    const res = await call(deps(sent), { list_id: id, remind: true });
    expect(await res.json()).toEqual({ status: 'reminded', email_sent: true, remaining: 1 });
    expect(sent[0].subject).toBe('Reminder: Onboarding documents');
    expect(sent[0].text).toContain('1 item still open');
    expect(sent[0].idempotencyKey).toBe(`needs-remind:${id}:0`);
    await call(deps(sent), { list_id: id, remind: true });
    expect(sent[1].idempotencyKey).toBe(`needs-remind:${id}:1`);
    expect((await listRow(id)).reminder_count).toBe(2);
  });

  it('a manual reminder ignores the pause and the cap', async () => {
    const id = await draft(withAccount);
    await call(deps([]), { list_id: id });
    await q(`UPDATE public.needs_lists SET reminders_paused = true, reminder_count = 50 WHERE id = $1`, [id]);
    const res = await call(deps([]), { list_id: id, remind: true });
    expect(res.status).toBe(200);
  });

  it('a failed reminder is an error and is not counted', async () => {
    const id = await draft(withAccount);
    await call(deps([]), { list_id: id });
    const res = await call(deps([], {}, () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 })), { list_id: id, remind: true });
    expect([res.status, (await res.json()).code]).toEqual([502, 'email_failed']);
    expect((await listRow(id)).reminder_count).toBe(0);
  });

  it('refuses a draft and a list with nothing open', async () => {
    const id = await draft(withAccount);
    const r1 = await call(deps([]), { list_id: id, remind: true });
    expect([r1.status, (await r1.json()).code]).toEqual([409, 'not_sent']);
    await call(deps([]), { list_id: id });
    await q(`UPDATE public.needs_items SET status = 'fulfilled' WHERE list_id = $1`, [id]);
    const [doc] = await q<{ id: string }>(
      `INSERT INTO public.client_documents (contact_id, filename, original_filename, storage_path, file_size, mime_type)
       VALUES ($1, 'a.pdf', 'a.pdf', 'p', 1, 'application/pdf') RETURNING id`, [withAccount]);
    await q(`INSERT INTO public.needs_item_documents (item_id, document_id)
             SELECT id, $2 FROM public.needs_items WHERE list_id = $1 AND kind = 'document'`, [id, doc.id]);
    const r2 = await call(deps([]), { list_id: id, remind: true });
    expect([r2.status, (await r2.json()).code]).toEqual([409, 'nothing_open']);
  });

  it('a contact still without an account gets a fresh link, and the older one stops working', async () => {
    const sent: Sent[] = [];
    const id = await draft(noAccount);
    let token = 0;
    const d = deps(sent);
    d.newToken = () => `${String(++token)}`.padStart(43, 'R');
    await call(d, { list_id: id });
    await call(d, { list_id: id, remind: true });
    expect((await links(id)).map((r) => r.status)).toEqual(['superseded', 'pending']);
    expect(sent[1].text).toContain(`/start#token=${'2'.padStart(43, 'R')}`);
  });
});
