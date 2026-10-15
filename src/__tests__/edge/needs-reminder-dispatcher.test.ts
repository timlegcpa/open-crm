// @vitest-environment node
// needs-reminder-dispatcher against the real migrations in PGlite: which sent requests a
// scheduled run reminds, and what it reports (counts only).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, seedContact, seedCore, seedPortalAccount } from '../db/harness';
import {
  createDispatcherHandler,
  DEFAULT_REMINDER_SETTINGS,
  isReminderDue,
  normalizeReminderSettings,
  type DispatcherDeps,
  type DispatchListRow,
} from '../../../supabase/functions/needs-reminder-dispatcher/handler';
import type { NeedsSendStore } from '../../../supabase/functions/send-needs-list/handler';
import type { SendResult } from '../../../supabase/functions/_shared/outbound';
import { CREDENTIALS, CRON_SECRET, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';

const SITE = 'https://crm.example.com';
const ORG = { displayName: 'Example Co', legalName: null, senderName: 'Example Co', postalAddress: null, logoUrl: null, brandColor: null };

let db: PGlite;
let active: string;
let inactive: string;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

function store(sent: string[], status: () => SendResult): NeedsSendStore {
  return {
    loadList: async (id) => (await q<never>(`SELECT id, contact_id, title, intro_message, status, content_version, reminder_count FROM public.needs_lists WHERE id = $1`, [id]))[0] ?? null,
    loadContact: async (id) => (await q<never>(`SELECT first_name, email FROM public.contacts WHERE id = $1`, [id]))[0] ?? null,
    countItems: async (id) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM public.needs_items WHERE list_id = $1`, [id]))[0].n,
    progress: async (id) => (await q<never>(`SELECT actionable, fulfilled, required_open FROM public.needs_list_progress(ARRAY[$1]::uuid[])`, [id]))[0],
    hasActivePortalAccount: async (c) => (await q(`SELECT 1 FROM public.client_portal_accounts WHERE contact_id = $1 AND status = 'active' AND user_id IS NOT NULL`, [c])).length > 0,
    issueStartLink: async () => {
      throw new Error('a scheduled reminder never mints a start link');
    },
    expireStartLink: async () => {},
    supersedeStartLinks: async () => {
      throw new Error('a scheduled reminder never mints a start link');
    },
    sendList: async () => 'not_draft',
    recipientCurrent: async (id, { contactId, email }) =>
      (await q<{ r: never }>(`SELECT public.needs_recipient_current($1, $2, $3) AS r`, [id, contactId, email]))[0].r,
    claimReminder: async (id, n) => (await q<{ r: never }>(`SELECT public.needs_claim_reminder($1, $2) AS r`, [id, n]))[0].r,
    releaseReminder: async (id, n, previous) => {
      await q(`SELECT public.needs_release_reminder($1, $2, $3)`, [id, n, previous]);
    },
    loadOrg: async () => ORG,
    async sendEmail({ to }) {
      sent.push(to);
      return status();
    },
  };
}

function deps(sent: string[], over: Partial<DispatcherDeps> = {}, status: () => SendResult = () => ({ status: 'sent', channel: 'local', id: null })): DispatcherDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: SITE,
    cronSecret: CRON_SECRET,
    authorizeOwner: fakeOwnerAuth(),
    loadSettings: async () => (await q<{ value: unknown }>(`SELECT value FROM public.app_settings WHERE key = 'needs_reminders'`))[0]?.value ?? null,
    sentLists: () => q<DispatchListRow>(
      `SELECT id, contact_id, title, intro_message, status, content_version, reminder_count, reminders_paused,
              sent_at::text, last_reminded_at::text
         FROM public.needs_lists WHERE status = 'sent' ORDER BY id`),
    async activeContacts(ids) {
      const rows = await q<{ contact_id: string }>(
        `SELECT DISTINCT contact_id FROM public.client_portal_accounts WHERE contact_id = ANY($1::uuid[]) AND status = 'active' AND user_id IS NOT NULL`, [ids]);
      return new Set(rows.map((r) => r.contact_id));
    },
    store: store(sent, status),
    logSink: () => {},
    ...over,
  };
}

const run = async (d: DispatcherDeps) => {
  const res = await createDispatcherHandler(d)(edgeRequest({ origin: null, headers: CREDENTIALS.cron }));
  return { status: res.status, body: await res.json() };
};

async function sentList(contactId: string, opts: { daysAgo: number; paused?: boolean; count?: number; answered?: boolean }): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO public.needs_lists (contact_id, title, status, sent_at, reminders_paused, reminder_count)
     VALUES ($1, 'Docs', 'sent', now() - ($2 || ' days')::interval, $3, $4) RETURNING id`,
    [contactId, String(opts.daysAgo), opts.paused ?? false, opts.count ?? 0]);
  await q(`INSERT INTO public.needs_items (list_id, kind, label, status) VALUES ($1, 'todo', 'Sign', $2)`,
    [row.id, opts.answered ? 'fulfilled' : 'pending']);
  return row.id;
}

const setSettings = (value: Record<string, unknown>) =>
  q(`INSERT INTO public.app_settings (key, value) VALUES ('needs_reminders', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  active = await seedContact(db, { first_name: 'Ada', email: 'ada@example.com' });
  await seedPortalAccount(db, active, { email: 'ada@example.com' });
  inactive = await seedContact(db, { first_name: 'Grace', email: 'grace@example.com' });
}, 60_000);

beforeEach(async () => {
  await q(`DELETE FROM public.needs_lists`);
  await q(`DELETE FROM public.app_settings WHERE key = 'needs_reminders'`);
});

describeEdgeContract({
  name: 'needs-reminder-dispatcher',
  handler: async (req) => createDispatcherHandler(deps([]))(req),
  failingHandler: async (req) => createDispatcherHandler(deps([], { loadSettings: throwInternal }))(req),
  credentials: CREDENTIALS.cron,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'optional_json' },
});

describe('needs-reminder-dispatcher', () => {
  it('is off until the owner turns it on', async () => {
    await sentList(active, { daysAgo: 30 });
    const sent: string[] = [];
    expect(await run(deps(sent))).toEqual({
      status: 200, body: { sent: 0, due: 0, failures: 0, skipped_zero_remaining: 0, skipped_in_progress: 0, enabled: false },
    });
    expect(sent).toEqual([]);
  });

  it('reminds due lists of contacts with a portal account, and skips the rest', async () => {
    await setSettings({ enabled: true, interval_days: 7, max_reminders: 3 });
    const due = await sentList(active, { daysAgo: 8 });
    await sentList(active, { daysAgo: 2 }); // not yet
    await sentList(active, { daysAgo: 30, paused: true });
    await sentList(active, { daysAgo: 30, count: 3 }); // at the cap
    await sentList(active, { daysAgo: 30, answered: true }); // nothing open
    await sentList(inactive, { daysAgo: 30 }); // no account: never on a schedule
    const sent: string[] = [];
    const { status, body } = await run(deps(sent));
    expect(status).toBe(200);
    expect(body).toEqual({ sent: 1, due: 3, failures: 0, skipped_zero_remaining: 1, skipped_in_progress: 0, enabled: true });
    expect(sent).toEqual(['ada@example.com']);
    expect((await q<{ n: number }>(`SELECT reminder_count AS n FROM public.needs_lists WHERE id = $1`, [due]))[0].n).toBe(1);
    // The next run waits for the interval again.
    expect((await run(deps(sent))).body.sent).toBe(0);
  });

  it('counts a failed email as a failure and does not advance the count', async () => {
    await setSettings({ enabled: true });
    const id = await sentList(active, { daysAgo: 8 });
    const { body } = await run(deps([], {}, () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 })));
    expect(body.failures).toBe(1);
    expect((await q<{ n: number }>(`SELECT reminder_count AS n FROM public.needs_lists WHERE id = $1`, [id]))[0].n).toBe(0);
  });

  it('nothing to do is a success with zero counts', async () => {
    await setSettings({ enabled: true });
    expect(await run(deps([]))).toEqual({
      status: 200, body: { sent: 0, due: 0, failures: 0, skipped_zero_remaining: 0, skipped_in_progress: 0, enabled: true },
    });
  });

  it('runs for the owner too', async () => {
    const res = await createDispatcherHandler(deps([]))(edgeRequest({ headers: CREDENTIALS.owner }));
    expect(res.status).toBe(200);
  });
});

describe('reminder settings and due math', () => {
  it('defaults off, and clamps what is stored', () => {
    expect(normalizeReminderSettings(null)).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(DEFAULT_REMINDER_SETTINGS.enabled).toBe(false);
    expect(normalizeReminderSettings({ enabled: 'yes', interval_days: 0, max_reminders: 99 })).toEqual({ enabled: false, interval_days: 1, max_reminders: 20 });
    expect(normalizeReminderSettings({ enabled: true, interval_days: 9999, max_reminders: 2.6 })).toEqual({ enabled: true, interval_days: 365, max_reminders: 3 });
  });

  it('is due from the last reminder, else from the send', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const row = (over: Partial<DispatchListRow>): DispatchListRow => ({
      id: 'x', contact_id: 'c', title: 't', intro_message: null, status: 'sent', content_version: 0, reminder_count: 0,
      reminders_paused: false, sent_at: '2026-06-01T12:00:00Z', last_reminded_at: null, ...over,
    });
    const s = { enabled: true, interval_days: 7, max_reminders: 2 };
    expect(isReminderDue(row({}), s, now)).toBe(true);
    expect(isReminderDue(row({ last_reminded_at: '2026-06-10T12:00:00Z' }), s, now)).toBe(false);
    expect(isReminderDue(row({ last_reminded_at: '2026-06-08T12:00:00Z' }), s, now)).toBe(true);
    expect(isReminderDue(row({ reminder_count: 2 }), s, now)).toBe(false);
    expect(isReminderDue(row({ reminders_paused: true }), s, now)).toBe(false);
    expect(isReminderDue(row({ status: 'submitted' }), s, now)).toBe(false);
    expect(isReminderDue(row({ sent_at: null }), s, now)).toBe(false);
  });
});
