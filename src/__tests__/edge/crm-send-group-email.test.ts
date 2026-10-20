// @vitest-environment node
// crm-send-group-email, run against the real migrations in PGlite. Every database step is
// the SQL the function's index.ts calls; only the email provider is faked, except where
// the real outbound adapter writes the real dev_outbox.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import {
  createGroupEmailHandler,
  EMAILABLE_STATUSES,
  emailConfigProblem,
  MAX_CAMPAIGNS_PER_HOUR,
  providerKeyFor,
  type ClaimResult,
  type ContactRow,
  type GroupEmailDeps,
  type ReplayResult,
} from '../../../supabase/functions/crm-send-group-email/handler';
import { mergeFirstName, renderGroupEmail } from '../../../supabase/functions/crm-send-group-email/render';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createOrgLoader } from '../../../supabase/functions/_shared/organization';
import { createOutbound, type EmailMessage, type OutboundEnv, type SendResult } from '../../../supabase/functions/_shared/outbound';
import { checkUserLimit } from '../../../supabase/functions/_shared/rate-limit';
import { CREDENTIALS, describeEdgeContract, fakeOwnerAuth, OWNER_ID, OWNER_TOKEN, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

// PGlite under a busy machine: a test that sends a dozen campaigns needs more than 5 s.
vi.setConfig({ testTimeout: 30_000 });

const SYSTEM = '00000000-0000-4000-8000-000000000002';
const ADA = '10000000-0000-4000-8000-000000000001';
const GRACE = '10000000-0000-4000-8000-000000000002';
const KATHERINE = '10000000-0000-4000-8000-000000000003';
const LOST = '10000000-0000-4000-8000-000000000004';
const NO_EMAIL = '10000000-0000-4000-8000-000000000005';
const SHARED = '10000000-0000-4000-8000-000000000006';
const ORIGIN = 'http://localhost:5173';
const SITE = 'https://crm.example.com';
const ONE_CLICK = 'https://project.example.supabase.co/functions/v1/email-unsubscribe';
const VISIBLE = `${SITE}/unsubscribe`;

const DEV: OutboundEnv = {
  production: false,
  resendApiKey: null,
  emailFrom: null,
  emailReplyTo: null,
  twilioAccountSid: null,
  twilioAuthToken: null,
  twilioFrom: null,
};
const PROVIDER: OutboundEnv = { ...DEV, production: true, resendApiKey: 'test-key', emailFrom: 'Example Co <news@example.com>' };

let db: PGlite;
let keyCounter = 0;
let tokenCounter = 0;
const newKey = () => `60000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`;

/** One committed statement as the server (service_role), like the edge client. */
async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let out: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    out = (await tx.query<T>(sql, params)).rows;
  });
  return out;
}

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const countOf = async (table: string, where = 'true') =>
  (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`))[0].n;

type Deps = GroupEmailDeps & { sent: EmailMessage[]; tokens: string[]; logs: string[] };

/** The function wired to the real SQL. `send` decides each provider answer (default: accepted). */
function deps(over: Partial<GroupEmailDeps> = {}, send?: (m: EmailMessage, n: number) => Promise<SendResult>): Deps {
  const sent: EmailMessage[] = [];
  const tokens: string[] = [];
  const logs: string[] = [];
  const client = serviceClient(db);
  const org = createOrgLoader({ db: client, supabaseUrl: 'https://project.example.supabase.co', ttlMs: 0 });
  let n = 0;
  return {
    sent,
    tokens,
    logs,
    allowedOrigins: [ORIGIN],
    authorizeOwner: fakeOwnerAuth(),
    siteUrl: SITE,
    oneClickUrl: ONE_CLICK,
    outboundEnv: PROVIDER,
    checkSendLimit: (ownerId) => checkUserLimit(client, { action: 'group_email', userId: ownerId, max: MAX_CAMPAIGNS_PER_HOUR, windowMinutes: 60 }),
    loadOrg: () => org.load(),
    readContacts: async (ids) =>
      asServer<ContactRow>(`SELECT id, first_name, email, status, archived_at FROM public.contacts WHERE id = ANY($1::uuid[])`, [ids]),
    readSuppressed: async (addresses) =>
      (await asServer<{ address: string }>(`SELECT address FROM public.email_suppressions WHERE address = ANY($1::text[])`, [addresses])).map((r) => r.address),
    begin: async (i) =>
      (await asServer<{ id: string | null }>(
        `SELECT public.group_email_begin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id`,
        [i.idempotencyKey, i.createdBy, i.subject, i.body, i.fromIdentity, i.audienceDescription,
          JSON.stringify(i.recipients), JSON.stringify(i.skips), JSON.stringify(i.tokens), i.skippedCount],
      ))[0].id,
    replay: async (key) => (await asServer<{ r: ReplayResult }>(`SELECT public.group_email_replay($1) AS r`, [key]))[0].r,
    claim: async (campaignId, address, emailable) =>
      (await asServer<{ r: ClaimResult }>(`SELECT public.group_email_claim($1, $2, $3) AS r`, [campaignId, address, emailable]))[0].r,
    record: async (campaignId, address, outcome, id, error) => {
      await asServer(`SELECT public.group_email_record($1, $2, $3, $4, $5)`, [campaignId, address, outcome, id, error]);
    },
    finish: async (campaignId, c) => {
      await asServer(`SELECT public.group_email_finish($1, $2, $3, $4, $5)`, [campaignId, c.sent, c.failed, c.unknown, c.skipped]);
    },
    sendEmail: async (m) => {
      sent.push(m);
      n += 1;
      return send ? send(m, n) : { status: 'sent', channel: 'resend', id: `msg-${n}` };
    },
    audit: async (ownerId, details, userAgent) => {
      await asServer(`INSERT INTO public.audit_logs (user_id, action, details, user_agent) VALUES ($1, 'group_email_sent', $2, $3)`,
        [ownerId, JSON.stringify(details), userAgent]);
    },
    newToken: () => {
      const token = `tok${++tokenCounter}${'x'.repeat(40)}`;
      tokens.push(token);
      return token;
    },
    logSink: (_level, line) => logs.push(line),
    ...over,
  };
}

function request(body: unknown, init: { token?: string | null; origin?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: init.origin ?? ORIGIN };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? OWNER_TOKEN}`;
  return new Request('http://edge.local/crm-send-group-email', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const send = (ids: string[], extra: Record<string, unknown> = {}) => ({
  subject: 'A quick update',
  body: 'Hi {{first_name}},\n\nNews.',
  contact_ids: ids,
  idempotency_key: newKey(),
  ...extra,
});
const preview = (ids: string[], extra: Record<string, unknown> = {}) => ({ mode: 'preview', subject: 'A quick update', body: 'Hi {{first_name}},\n\nNews.', contact_ids: ids, ...extra });

async function call(d: GroupEmailDeps, body: unknown) {
  const res = await createGroupEmailHandler(d)(request(body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Every table a send writes, counted. */
const writes = async () => ({
  campaigns: await countOf('crm_email_campaigns'),
  recipients: await countOf('crm_email_recipients'),
  tokens: await countOf('email_unsubscribe_tokens'),
  audit: await countOf('audit_logs'),
  outbox: await countOf('dev_outbox'),
  limits: await countOf('auth_rate_limits'),
});

beforeEach(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER_ID}', 'owner@example.com'), ('${SYSTEM}', 'system@example.com');
    INSERT INTO public.org_profile (display_name, sender_name, owner_user_id, system_user_id)
      VALUES ('Acme LLC', 'Acme Team', '${OWNER_ID}', '${SYSTEM}');
    INSERT INTO public.contacts (id, first_name, last_name, email, status) VALUES
      ('${ADA}', 'Ada', 'Lovelace', 'ada@example.com', 'client'),
      ('${GRACE}', 'Grace', 'Hopper', 'Grace@Example.com', 'hot'),
      ('${KATHERINE}', 'Katherine', 'Johnson', 'katherine@example.com', 'former_client'),
      ('${LOST}', 'Lin', 'Lost', 'lin@example.com', 'lost'),
      ('${NO_EMAIL}', 'Nia', 'None', NULL, 'client'),
      ('${SHARED}', 'Sam', 'Shared', 'ada@example.com', 'warm');
  `);
}, 60_000);

describeEdgeContract({
  name: 'crm-send-group-email',
  get handler() {
    return createGroupEmailHandler(deps());
  },
  get failingHandler() {
    return createGroupEmailHandler(deps({ readContacts: throwInternal }));
  },
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: send([ADA]), maxBytes: 256 * 1024 },
});

describe('crm-send-group-email: a send', () => {
  it('mails each eligible contact its own copy, skips the rest, and logs every row', async () => {
    const d = deps();
    const res = await call(d, send([ADA, GRACE, KATHERINE, LOST, NO_EMAIL]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 3, failed: 0, unknown: 0, skipped: 2, delivery: 'provider' });
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com', 'grace@example.com', 'katherine@example.com']);
    const log = await rows<{ address: string; status: string; provider_message_id: string | null }>(
      `SELECT address, status, provider_message_id FROM public.crm_email_recipients ORDER BY address`);
    expect(log).toEqual([
      { address: 'ada@example.com', status: 'sent', provider_message_id: 'msg-1' },
      { address: 'grace@example.com', status: 'sent', provider_message_id: 'msg-2' },
      { address: 'katherine@example.com', status: 'sent', provider_message_id: 'msg-3' },
    ]);
    const [campaign] = await rows(`SELECT status, sent_count, skipped_count, recipient_count, from_identity, created_by FROM public.crm_email_campaigns`);
    expect(campaign).toEqual({ status: 'sent', sent_count: 3, skipped_count: 2, recipient_count: 3, from_identity: 'Acme Team <news@example.com>', created_by: OWNER_ID });
  });

  it('sends one message per recipient with a working one-click header and its own token', async () => {
    const d = deps();
    await call(d, send([ADA, GRACE]));
    expect(d.sent).toHaveLength(2);
    for (const [i, m] of d.sent.entries()) {
      expect(m.listUnsubscribe).toEqual({ url: `${ONE_CLICK}?t=${d.tokens[i]}`, oneClick: true });
      expect(m.fromName).toBe('Acme Team');
      expect(m.html).toContain(`${VISIBLE}?t=${d.tokens[i]}`);
    }
    const hashes = await rows<{ token_hash: string; address: string }>(`SELECT token_hash, address FROM public.email_unsubscribe_tokens ORDER BY address`);
    expect(hashes).toEqual([
      { token_hash: await sha256Hex(d.tokens[0]), address: 'ada@example.com' },
      { token_hash: await sha256Hex(d.tokens[1]), address: 'grace@example.com' },
    ]);
  });

  it('renders the send through the one renderer the preview uses, differing only in the token', async () => {
    const d = deps();
    const pre = await call(d, preview([GRACE]));
    await call(d, send([GRACE]));
    const org = await d.loadOrg();
    const body = 'Hi {{first_name}},\n\nNews.';
    expect(pre.body.html).toBe(renderGroupEmail(org, body, 'Grace', VISIBLE).html);
    expect(d.sent[0].html).toBe(renderGroupEmail(org, body, 'Grace', `${VISIBLE}?t=${d.tokens[0]}`).html);
    expect(d.sent[0].text).toBe(renderGroupEmail(org, body, 'Grace', `${VISIBLE}?t=${d.tokens[0]}`).text);
  });

  it('keys each message by campaign and hashed address: 69 characters, the same on every retry', async () => {
    const d = deps();
    const res = await call(d, send([ADA]));
    const campaignId = res.body.campaign_id as string;
    expect(d.sent[0].idempotencyKey).toBe(await providerKeyFor(campaignId, 'ada@example.com'));
    const long = `${'a'.repeat(240)}@example.com`;
    expect((await providerKeyFor(campaignId, long)).length).toBe(69);
    expect(await providerKeyFor(campaignId, long)).toBe(await providerKeyFor(campaignId, long));
  });

  it('audits the run with ids and counts only, never the subject', async () => {
    await call(deps(), send([ADA, LOST]));
    const [audit] = await rows<{ user_id: string; details: Record<string, unknown> }>(`SELECT user_id, details FROM public.audit_logs`);
    expect(audit.user_id).toBe(OWNER_ID);
    expect(audit.details).toMatchObject({ recipients: 1, sent: 1, failed: 0, unknown: 0, skipped: 1, late_suppressed: 0 });
    expect(JSON.stringify(audit.details)).not.toContain('quick update');
  });

  it('a failed audit write does not report a completed send as failed', async () => {
    const d = deps({ audit: async () => { throw new Error('audit down'); } });
    const res = await call(d, send([ADA]));
    expect(res.status).toBe(200);
    expect(d.logs.some((l) => l.includes('audit failed'))).toBe(true);
  });

  it('writes to the real dev outbox when no provider is configured, and says so', async () => {
    const outbound = createOutbound({ env: DEV, db: serviceClient(db) });
    const d = deps({ outboundEnv: DEV, sendEmail: (m) => outbound.sendEmail(m) });
    const res = await call(d, send([ADA]));
    expect(res.body).toMatchObject({ sent: 1, delivery: 'dev_outbox' });
    const [row] = await rows<{ recipient: string; sender: string; headers: Record<string, string>; idempotency_key: string; body_html: string }>(
      `SELECT recipient, sender, headers, idempotency_key, body_html FROM public.dev_outbox`);
    expect(row.recipient).toBe('ada@example.com');
    expect(row.sender).toBe('Acme Team');
    expect(row.headers['List-Unsubscribe']).toBe(`<${ONE_CLICK}?t=${d.tokens[0]}>`);
    expect(row.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(row.idempotency_key).toBe(await providerKeyFor(res.body.campaign_id as string, 'ada@example.com'));
    expect(row.body_html).toContain(`${VISIBLE}?t=${d.tokens[0]}`);
  });
});

describe('crm-send-group-email: who is mailed', () => {
  it('resolves addresses on the server, lower-cased, and never from the request', async () => {
    const d = deps();
    await call(d, send([GRACE], { address: 'attacker@example.net', to: ['attacker@example.net'] }));
    expect(d.sent.map((m) => m.to)).toEqual(['grace@example.com']);
  });

  it('two contacts sharing an address get one message; the second is skipped with no row', async () => {
    const d = deps();
    const res = await call(d, send([SHARED, ADA]));
    expect(res.body).toMatchObject({ sent: 1, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com']);
    // The request's order decides who wins: Sam asked first.
    expect(d.sent[0].html).toContain('Hi Sam');
    expect(await rows(`SELECT contact_id, status FROM public.crm_email_recipients`)).toEqual([{ contact_id: SHARED, status: 'sent' }]);
  });

  it('skips an archived contact before the run: no message, no row', async () => {
    await db.exec(`UPDATE public.contacts SET archived_at = now() WHERE id = '${ADA}'`);
    const d = deps();
    const res = await call(d, send([ADA, GRACE]));
    expect(res.body).toMatchObject({ sent: 1, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['grace@example.com']);
    expect(await rows(`SELECT contact_id FROM public.crm_email_recipients`)).toEqual([{ contact_id: GRACE }]);
  });

  it('collapses repeated ids and ignores ids that are not contacts', async () => {
    const d = deps();
    const res = await call(d, send([ADA, ADA, 'not-an-id', '10000000-0000-4000-8000-0000000000ff']));
    expect(res.body).toMatchObject({ sent: 1, skipped: 0 });
  });

  it('bounds the raw list before filtering it: 251 entries are refused even if most are junk', async () => {
    const ids = [ADA, ...Array.from({ length: 250 }, () => 'junk')];
    const res = await call(deps(), send(ids));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A group email goes to at most 250 people.');
    expect(await countOf('crm_email_campaigns')).toBe(0);
  });

  it('refuses an empty list, a list of junk, and a list where nobody can be emailed', async () => {
    expect((await call(deps(), send([]))).status).toBe(400);
    expect((await call(deps(), send(['junk']))).status).toBe(400);
    const res = await call(deps(), send([LOST, NO_EMAIL]));
    expect(res.status).toBe(400);
    expect(await countOf('crm_email_campaigns')).toBe(0);
  });

  it('refuses a subject over 200 characters or on two lines, and an empty or oversized body', async () => {
    for (const extra of [{ subject: 'x'.repeat(201) }, { subject: 'Hi\nBcc: someone@example.net' }, { body: '   ' }, { body: 'x'.repeat(50_001) }]) {
      expect((await call(deps(), send([ADA], extra))).status).toBe(400);
    }
    expect(await writes()).toMatchObject({ campaigns: 0, limits: 0 });
  });
});

describe('crm-send-group-email: suppression', () => {
  it('skips a suppressed address before the run: no token, no message, a skipped row', async () => {
    await db.exec(`INSERT INTO public.email_suppressions (address) VALUES ('ADA@example.com')`);
    const d = deps();
    const res = await call(d, send([ADA, GRACE]));
    expect(res.body).toMatchObject({ sent: 1, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['grace@example.com']);
    expect(await rows(`SELECT address FROM public.email_unsubscribe_tokens`)).toEqual([{ address: 'grace@example.com' }]);
    expect(await rows(`SELECT status, error FROM public.crm_email_recipients WHERE address = 'ada@example.com'`)).toEqual([
      { status: 'skipped', error: 'unsubscribed' },
    ]);
  });

  it('honours an unsubscribe that lands mid-run: the re-check before each send skips it', async () => {
    const d = deps({}, async (_m, n) => {
      if (n === 1) await db.exec(`INSERT INTO public.email_suppressions (address) VALUES ('grace@example.com')`);
      return { status: 'sent', channel: 'resend', id: `msg-${n}` };
    });
    const res = await call(d, send([ADA, GRACE, KATHERINE]));
    expect(res.body).toMatchObject({ sent: 2, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com', 'katherine@example.com']);
    expect(await rows(`SELECT status, error FROM public.crm_email_recipients WHERE address = 'grace@example.com'`)).toEqual([
      { status: 'skipped', error: 'unsubscribed' },
    ]);
    const [audit] = await rows<{ details: { late_suppressed: number } }>(`SELECT details FROM public.audit_logs`);
    expect(audit.details.late_suppressed).toBe(1);
  });

  it('a contact deleted mid-run is not mailed, and leaves no row with its address', async () => {
    const d = deps({}, async (_m, n) => {
      if (n === 1) await db.query(`DELETE FROM public.contacts WHERE id = $1`, [GRACE]);
      return { status: 'sent', channel: 'resend', id: `msg-${n}` };
    });
    const res = await call(d, send([ADA, GRACE, KATHERINE]));
    expect(res.status).toBe(200);
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com', 'katherine@example.com']);
    expect(await rows(`SELECT 1 FROM public.crm_email_recipients WHERE address = 'grace@example.com'`)).toEqual([]);
  });

  it('a contact marked lost mid-run is not mailed: the re-check before each send skips it', async () => {
    const d = deps({}, async (_m, n) => {
      if (n === 1) await db.query(`UPDATE public.contacts SET status = 'lost' WHERE id = $1`, [GRACE]);
      return { status: 'sent', channel: 'resend', id: `msg-${n}` };
    });
    const res = await call(d, send([ADA, GRACE, KATHERINE]));
    expect(res.body).toMatchObject({ sent: 2, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com', 'katherine@example.com']);
    expect(await rows(`SELECT status, error FROM public.crm_email_recipients WHERE address = 'grace@example.com'`)).toEqual([
      { status: 'skipped', error: 'status lost' },
    ]);
    const [audit] = await rows<{ details: { late_ineligible: number } }>(`SELECT details FROM public.audit_logs`);
    expect(audit.details.late_ineligible).toBe(1);
  });

  it('the claim refuses when it is given no emailable statuses', async () => {
    const base = deps();
    const d = deps({ claim: (campaignId, address) => base.claim(campaignId, address, []) });
    const res = await call(d, send([ADA]));
    expect(res.body).toMatchObject({ sent: 0, skipped: 1 });
    expect(d.sent).toHaveLength(0);
  });

  it('fails closed when the suppression list cannot be read: nothing written, nothing sent', async () => {
    const d = deps({ readSuppressed: async () => { throw new Error('db down'); } });
    const res = await call(d, send([ADA]));
    expect(res.status).toBe(500);
    expect(d.sent).toHaveLength(0);
    expect(await writes()).toMatchObject({ campaigns: 0, recipients: 0, tokens: 0 });
  });

  it('skips a recipient whose re-check could not run', async () => {
    const base = deps();
    const d = deps({
      claim: async (campaignId, address, emailable) => {
        if (address === 'grace@example.com') throw new Error('db down');
        return base.claim(campaignId, address, emailable);
      },
    });
    const res = await call(d, send([ADA, GRACE]));
    expect(res.body).toMatchObject({ sent: 1, skipped: 1 });
    expect(d.sent.map((m) => m.to)).toEqual(['ada@example.com']);
    expect(await rows(`SELECT status, error FROM public.crm_email_recipients WHERE address = 'grace@example.com'`)).toEqual([
      { status: 'skipped', error: 'eligibility check unavailable' },
    ]);
  });
});

describe('crm-send-group-email: preview', () => {
  it('writes nothing, sends nothing, and answers with whose copy it is', async () => {
    const d = deps();
    const before = await writes();
    const res = await call(d, preview([GRACE, ADA, LOST]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ preview: true, sample: { first_name: 'Grace', address: 'grace@example.com' }, eligible: 2, skipped: 1, delivery: 'provider' });
    expect(res.body.html).toContain('Hi Grace');
    expect(d.sent).toHaveLength(0);
    expect(await writes()).toEqual(before);
  });

  it('previews the same person twice for the same composition (the request order)', async () => {
    const a = await call(deps(), preview([KATHERINE, ADA]));
    const b = await call(deps(), preview([KATHERINE, ADA]));
    expect(a.body.sample).toEqual({ first_name: 'Katherine', address: 'katherine@example.com' });
    expect(b.body.sample).toEqual(a.body.sample);
  });

  it('does not spend the hourly allowance; the sixth send in an hour is refused', async () => {
    const d = deps();
    for (let i = 0; i < MAX_CAMPAIGNS_PER_HOUR; i++) {
      expect((await call(d, preview([ADA]))).status).toBe(200);
      expect((await call(d, send([ADA]))).status).toBe(200);
    }
    expect((await call(d, preview([ADA]))).status).toBe(200);
    const sixth = await call(d, send([ADA]));
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: 'Too many sends. Try again later.', code: 'rate_limited' });
  });

  it('refuses an unknown mode rather than defaulting to a send', async () => {
    const d = deps();
    const res = await call(d, { ...send([ADA]), mode: 'draft' });
    expect(res.status).toBe(400);
    expect(d.sent).toHaveLength(0);
    expect(await writes()).toMatchObject({ campaigns: 0, limits: 0 });
  });

  it('a send without its request id is refused before anything is written', async () => {
    const d = deps();
    for (const key of [undefined, 'not-a-uuid']) {
      const res = await call(d, send([ADA], { idempotency_key: key }));
      expect(res.status).toBe(400);
    }
    expect(d.sent).toHaveLength(0);
    expect(await writes()).toMatchObject({ campaigns: 0, limits: 0 });
  });
});

describe('crm-send-group-email: configuration fails closed', () => {
  it('no SITE_URL: refused with a code, for a send and a preview, before anything is written', async () => {
    for (const body of [send([ADA]), preview([ADA])]) {
      const res = await call(deps({ siteUrl: null }), body);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('site_url_missing');
    }
    expect(await writes()).toMatchObject({ campaigns: 0, limits: 0 });
  });

  it('production with no provider key: refused, never parked in the dev outbox', async () => {
    const res = await call(deps({ outboundEnv: { ...DEV, production: true } }), send([ADA]));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('email_not_configured');
    expect(await writes()).toMatchObject({ campaigns: 0, outbox: 0, limits: 0 });
  });

  it('names each configuration problem', () => {
    expect(emailConfigProblem(DEV)).toBeNull();
    expect(emailConfigProblem(PROVIDER)).toBeNull();
    expect(emailConfigProblem({ ...DEV, production: true })).toMatch(/RESEND_API_KEY/);
    expect(emailConfigProblem({ ...DEV, resendApiKey: 'k' })).toMatch(/EMAIL_FROM/);
  });

  it('a limiter that cannot answer refuses the send', async () => {
    const res = await call(deps({ checkSendLimit: async () => 'unavailable' }), send([ADA]));
    expect(res.status).toBe(503);
    expect(await countOf('crm_email_campaigns')).toBe(0);
  });
});

describe('crm-send-group-email: provider answers', () => {
  it('no answer is UNKNOWN, never failed: the campaign is not failed and its key is never released', async () => {
    const d = deps({}, async () => ({ status: 'unknown', channel: 'resend' }));
    const body = send([ADA, GRACE]);
    const res = await call(d, body);
    expect(res.body).toMatchObject({ sent: 0, failed: 0, unknown: 2 });
    expect(await rows(`SELECT DISTINCT status FROM public.crm_email_recipients`)).toEqual([{ status: 'unknown' }]);
    expect(await rows(`SELECT status, unknown_count FROM public.crm_email_campaigns`)).toEqual([{ status: 'sent', unknown_count: 2 }]);
    // Long after: a retry is a duplicate report, never a release.
    await db.exec(`UPDATE public.crm_email_campaigns SET created_at = now() - interval '1 hour'`);
    const retry = await call(deps(), body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, unknown: 2, still_running: false });
  });

  it('a send that throws is unknown too', async () => {
    const d = deps({}, async () => { throw new Error('socket hang up'); });
    const res = await call(d, send([ADA]));
    expect(res.body).toMatchObject({ unknown: 1, failed: 0 });
  });

  it('a refusal is failed (a retry is safe); a run where every send failed is failed and releasable', async () => {
    const d = deps({}, async () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 }));
    const body = send([ADA, GRACE]);
    const res = await call(d, body);
    expect(res.body).toMatchObject({ sent: 0, failed: 2 });
    expect(await rows(`SELECT DISTINCT status, error FROM public.crm_email_recipients`)).toEqual([{ status: 'failed', error: 'rejected (422)' }]);
    expect(await rows(`SELECT status FROM public.crm_email_campaigns`)).toEqual([{ status: 'failed' }]);
    // The retry releases the key and sends, as a new campaign.
    const again = await call(deps(), body);
    expect(again.body).toMatchObject({ sent: 2 });
    expect(again.body).not.toHaveProperty('duplicate');
  });

  it('a partial failure is a completed run, not a failed one', async () => {
    const d = deps({}, async (_m, n) => (n === 1 ? { status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 } : { status: 'sent', channel: 'resend', id: 'm' }));
    await call(d, send([ADA, GRACE]));
    expect(await rows(`SELECT status, sent_count, failed_count FROM public.crm_email_campaigns`)).toEqual([{ status: 'sent', sent_count: 1, failed_count: 1 }]);
  });

  it('a lost outcome write does not stop the run', async () => {
    const d = deps({ record: async () => { throw new Error('db down'); } });
    const res = await call(d, send([ADA, GRACE]));
    expect(res.body).toMatchObject({ sent: 2 });
    expect(d.sent).toHaveLength(2);
  });
});

describe('crm-send-group-email: the same composition twice', () => {
  /** A campaign begun under `key` whose worker died before it sent anything. */
  async function begunCampaign(key: string, recipients: { contact_id: string; address: string }[]): Promise<string> {
    const [{ id }] = await asServer<{ id: string }>(
      `SELECT public.group_email_begin($1, $2, 'A quick update', 'Body', 'Acme Team', null, $3, '[]', $4, 0) AS id`,
      [key, OWNER_ID, JSON.stringify(recipients),
        JSON.stringify(recipients.map((r, i) => ({ token_hash: String(i).repeat(64).slice(0, 64), address: r.address })))],
    );
    return id;
  }

  it('a double-click: the second request reports the first, still running, and sends nothing', async () => {
    const body = send([ADA, GRACE]);
    await begunCampaign(body.idempotency_key, [{ contact_id: ADA, address: 'ada@example.com' }, { contact_id: GRACE, address: 'grace@example.com' }]);
    const d = deps();
    const res = await call(d, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true, sent: 0, unsent: 2, still_running: true });
    expect(d.sent).toHaveLength(0);
    expect(await countOf('crm_email_campaigns')).toBe(1);
  });

  it('a stale campaign that only queued: it is closed as not sent, the key released, and the retry sends', async () => {
    const body = send([ADA]);
    const id = await begunCampaign(body.idempotency_key, [{ contact_id: ADA, address: 'ada@example.com' }]);
    await db.exec(`UPDATE public.crm_email_campaigns SET created_at = now() - interval '16 minutes'`);
    const d = deps();
    const res = await call(d, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 1 });
    expect(d.sent).toHaveLength(1);
    expect(await rows(`SELECT idempotency_key, status FROM public.crm_email_campaigns WHERE id = $1`, [id])).toEqual([
      { idempotency_key: null, status: 'failed' },
    ]);
  });

  it('a stale campaign with a claimed row: the row becomes unknown and the key stays reserved', async () => {
    const body = send([ADA, GRACE]);
    const id = await begunCampaign(body.idempotency_key, [{ contact_id: ADA, address: 'ada@example.com' }, { contact_id: GRACE, address: 'grace@example.com' }]);
    await asServer(`SELECT public.group_email_claim($1, 'ada@example.com', $2)`, [id, EMAILABLE_STATUSES]);
    await db.exec(`UPDATE public.crm_email_campaigns SET created_at = now() - interval '16 minutes'`);
    const res = await call(deps(), body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true, unknown: 1, unsent: 1, still_running: false });
    expect(await rows(`SELECT status, error FROM public.crm_email_recipients WHERE address = 'ada@example.com'`)).toEqual([
      { status: 'unknown', error: 'interrupted; delivery unknown' },
    ]);
    expect(await rows(`SELECT idempotency_key FROM public.crm_email_campaigns`)).toEqual([{ idempotency_key: body.idempotency_key }]);
    // The campaign is closed with the truth, so the pages show the unknown warning.
    expect(await rows(`SELECT status, unknown_count, sent_count, sent_at IS NOT NULL AS closed FROM public.crm_email_campaigns`)).toEqual([
      { status: 'sent', unknown_count: 1, sent_count: 0, closed: true },
    ]);
  });

  it('the counters move with the run, so a run that died mid-loop still reports what left', async () => {
    const body = send([ADA, GRACE]);
    const id = await begunCampaign(body.idempotency_key, [{ contact_id: ADA, address: 'ada@example.com' }, { contact_id: GRACE, address: 'grace@example.com' }]);
    await asServer(`SELECT public.group_email_claim($1, 'ada@example.com', $2)`, [id, EMAILABLE_STATUSES]);
    await asServer(`SELECT public.group_email_record($1, 'ada@example.com', 'sent', 'm1', null)`, [id]);
    expect(await rows(`SELECT claimed_count, sent_count FROM public.crm_email_campaigns`)).toEqual([{ claimed_count: 1, sent_count: 1 }]);
    const res = await call(deps(), body);
    expect(res.body).toMatchObject({ duplicate: true, sent: 1, unsent: 1, still_running: true });
  });

  it('reports the larger skip count: a skip with no address has no row', async () => {
    const d = deps();
    const body = send([ADA, LOST, NO_EMAIL]);
    expect((await call(d, body)).body).toMatchObject({ sent: 1, skipped: 2 });
    expect(await countOf('crm_email_recipients', `status = 'skipped'`)).toBe(0);
    expect((await call(deps(), body)).body).toMatchObject({ duplicate: true, sent: 1, skipped: 2 });
  });

  describe('deleting the contact a campaign logged never frees its key (another contact shares the address)', () => {
    const age = () => db.exec(`UPDATE public.crm_email_campaigns SET created_at = now() - interval '20 minutes'`);
    const deleteAda = () => db.query(`DELETE FROM public.contacts WHERE id = $1`, [ADA]);

    it('after a delivered send', async () => {
      const body = send([ADA, SHARED]);
      expect((await call(deps(), body)).body).toMatchObject({ sent: 1 });
      await age();
      await deleteAda();
      const d = deps();
      const res = await call(d, body);
      expect(res.body).toMatchObject({ duplicate: true, sent: 1 });
      expect(d.sent).toHaveLength(0);
    });

    it('after a send with no answer', async () => {
      const body = send([ADA, SHARED]);
      expect((await call(deps({}, async () => ({ status: 'unknown', channel: 'resend' })), body)).body).toMatchObject({ unknown: 1 });
      await age();
      await deleteAda();
      const d = deps();
      const res = await call(d, body);
      expect(res.body).toMatchObject({ duplicate: true, unknown: 1 });
      expect(d.sent).toHaveLength(0);
    });

    it('after a run that died between the provider call and any record of it', async () => {
      const body = send([ADA, SHARED]);
      const dying = deps({
        record: async () => { throw new Error('db down'); },
        finish: async () => { throw new Error('db down'); },
      });
      await call(dying, body);
      expect(dying.sent).toHaveLength(1);
      await age();
      await deleteAda();
      const d = deps();
      const res = await call(d, body);
      expect(res.body).toMatchObject({ duplicate: true, unknown: 1 });
      expect(d.sent).toHaveLength(0);
    });
  });

  it('a retry is answered before the rate limit, and spends nothing', async () => {
    const body = send([ADA]);
    expect((await call(deps(), body)).body).toMatchObject({ sent: 1 });
    const limits = await countOf('auth_rate_limits');
    for (let i = 0; i < 3; i++) expect((await call(deps(), body)).body).toMatchObject({ duplicate: true, sent: 1 });
    expect(await countOf('auth_rate_limits')).toBe(limits);
    const limited = await call(deps({ checkSendLimit: async () => 'limited' }), body);
    expect(limited).toMatchObject({ status: 200, body: { duplicate: true, sent: 1 } });
  });

  it('a retry is answered before the audience is read: an audience that has since emptied still gets its report', async () => {
    const body = send([ADA]);
    await call(deps(), body);
    await db.query(`UPDATE public.contacts SET status = 'lost' WHERE id = $1`, [ADA]);
    const readContacts = vi.fn();
    const res = await call(deps({ readContacts }), body);
    expect(res).toMatchObject({ status: 200, body: { duplicate: true, sent: 1 } });
    expect(readContacts).not.toHaveBeenCalled();
  });

  it('a write that fails while beginning sends nothing and leaves the key free', async () => {
    const d = deps({ begin: throwInternal });
    const body = send([ADA]);
    expect((await call(d, body)).status).toBe(500);
    expect(d.sent).toHaveLength(0);
    const ok = await call(deps(), body);
    expect(ok.body).toMatchObject({ sent: 1 });
  });
});

describe('crm-send-group-email: who may call it', () => {
  it('refuses no token, a non-owner and another origin before reading anything', async () => {
    const readContacts = vi.fn();
    const d = deps({ readContacts });
    const handler = createGroupEmailHandler(d);
    expect((await handler(request(send([ADA]), { token: null }))).status).toBe(401);
    expect((await handler(request(send([ADA]), { token: 'someone-else' }))).status).toBe(401);
    expect((await handler(request(send([ADA]), { origin: 'https://elsewhere.example' }))).status).toBe(403);
    expect(readContacts).not.toHaveBeenCalled();
  });
});

describe('the group email renderer', () => {
  const org = { displayName: 'Acme LLC', legalName: null, senderName: 'Acme Team', postalAddress: null, logoUrl: null, brandColor: null };

  it('merges {{first_name}} spaced or not, and greets "there" without a name', () => {
    expect(mergeFirstName('Hi {{first_name}} and {{ first_name }}', 'Ada')).toBe('Hi Ada and Ada');
    expect(mergeFirstName('Hi {{first_name}}', '  ')).toBe('Hi there');
  });

  it('puts a name like $& in literally', () => {
    expect(mergeFirstName('Hi {{first_name}}!', '$&')).toBe('Hi $&!');
    expect(mergeFirstName('Hi {{first_name}}!', '$1$$')).toBe('Hi $1$$!');
  });

  it('escapes the body and the name, keeps line breaks and starts a paragraph at a blank line', () => {
    const { html } = renderGroupEmail(org, 'Hi {{first_name}},\nline two\n\n<script>alert(1)</script>', '<b>Ada', `${VISIBLE}?t=abc`);
    expect(html).toContain('Hi &lt;b&gt;Ada,<br>line two</p>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Ada');
  });

  it('always carries the unsubscribe link and the reason, in both parts', () => {
    const { html, text } = renderGroupEmail(org, 'Body', 'Ada', `${VISIBLE}?t=a"b`);
    expect(html).toContain(`href="${VISIBLE}?t=a%22b"`);
    expect(html).toContain('Acme LLC&#39;s contacts');
    expect(text).toContain(`Unsubscribe: ${VISIBLE}?t=a%22b`);
    expect(html.match(/<body/g)).toHaveLength(1);
  });
});
