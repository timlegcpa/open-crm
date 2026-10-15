// @vitest-environment node
// lead-intake: the contract parser, the key check and its cache, and the endpoint run
// against the real migrations in PGlite (lead_intake_record and the rate-limit buckets).
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, seedCore } from '../db/harness';
import { serviceClient } from './pgliteClient';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { checkPublicLimits } from '../../../supabase/functions/_shared/rate-limit';
import { REFUSALS } from '../../../supabase/functions/_shared/handler';
import { createLeadIntakeHandler, type LeadIntakeDeps, type RecordResult } from '../../../supabase/functions/lead-intake/handler';
import {
  createKeyVerifier,
  KEY_PREFIX,
  newLeadIntakeKey,
} from '../../../supabase/functions/lead-intake/key';
import { presentedApiKey as presentedKey } from '../../../supabase/functions/_shared/http';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { isValidLeadEmail, leadNoteBody, leadNotification, parseLead, type Lead } from '../../../supabase/functions/lead-intake/lead';

const KEY = `${KEY_PREFIX}${'k'.repeat(43)}`;
const valid = {
  external_id: 'LD-10021',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  phone: '555-0134',
  business_name: 'Acme LLC',
  notes: 'Wants a monthly retainer.',
};

function parseOrThrow(raw: unknown): Lead {
  const r = parseLead(raw);
  if (!r.ok) throw new Error(`expected a valid lead, got: ${r.error}`);
  return r.lead;
}

describe('parseLead: shape', () => {
  it('accepts a full payload', () => {
    expect(parseOrThrow(valid)).toEqual(valid);
  });

  it('accepts a minimal payload and nulls every optional field', () => {
    expect(parseOrThrow({ external_id: 'LD-1', first_name: 'Ada', email: 'ada@example.com' })).toEqual({
      external_id: 'LD-1', first_name: 'Ada', last_name: null, email: 'ada@example.com', phone: null, business_name: null, notes: null,
    });
  });

  it.each([null, undefined, 'a string', 42, true, [valid]])('refuses a body that is not an object: %p', (body) => {
    expect(parseLead(body).ok).toBe(false);
  });
});

describe('parseLead: required fields', () => {
  it.each(['external_id', 'first_name', 'email'] as const)('refuses a missing %s, naming it', (key) => {
    const body: Record<string, unknown> = { ...valid };
    delete body[key];
    const r = parseLead(body);
    expect(r.ok === false && r.error).toContain(key);
  });

  // Trimmed BEFORE the required test, or a single space would satisfy it and store nothing.
  it.each(['   ', '\t', '\n'])('refuses a whitespace-only first_name %j', (ws) => {
    expect(parseLead({ ...valid, first_name: ws }).ok).toBe(false);
  });

  it('treats a whitespace-only optional field as absent, and an explicit null too', () => {
    expect(parseOrThrow({ ...valid, business_name: '   ' }).business_name).toBeNull();
    expect(parseOrThrow({ ...valid, phone: null }).phone).toBeNull();
  });
});

describe('parseLead: types are checked, never coerced', () => {
  it.each([['number', 42], ['boolean', true], ['object', { toString: 'no' }], ['array', ['a']]])(
    'refuses a %s first_name rather than turning it into text',
    (_label, value) => {
      const r = parseLead({ ...valid, first_name: value });
      expect(r.ok === false && r.error).toContain('must be a string');
    },
  );

  it('refuses a numeric external_id', () => {
    expect(parseLead({ ...valid, external_id: 10021 }).ok).toBe(false);
  });

  it('reads only its own keys, never inherited ones', () => {
    const inherited = Object.create({ first_name: 'Inherited' }) as Record<string, unknown>;
    Object.assign(inherited, { external_id: 'LD-2', email: 'ada@example.com' });
    expect(parseLead(inherited).ok).toBe(false);
  });
});

describe('parseLead: the external id is restricted, never cleaned up', () => {
  it.each(['LD-10021', 'ld_2026.08.31', 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d', 'ns:lead:88', 'X'])('accepts %j', (id) => {
    expect(parseLead({ ...valid, external_id: id }).ok).toBe(true);
  });

  it.each([
    ['newline', 'LD\n10021'], ['carriage return', 'LD\r10021'], ['NUL', 'LD' + String.fromCharCode(0) + '1'],
    ['emoji', 'LD-🚀'], ['non-ASCII letter', 'LD-café'], ['space', 'LD 10021'], ['leading hyphen', '-LD10021'], ['slash', 'LD/10021'],
  ])('refuses a %s', (_label, id) => {
    const r = parseLead({ ...valid, external_id: id });
    expect(r.ok === false && r.error).toContain('external_id');
  });

  it('every accepted id makes a usable idempotency key header', () => {
    for (const id of ['LD-10021', 'ld_2026.08.31', 'ns:lead:88', 'z'.repeat(128)]) {
      const lead = parseOrThrow({ ...valid, external_id: id });
      expect(() => new Headers({ 'Idempotency-Key': `lead-intake:${lead.external_id}` })).not.toThrow();
    }
  });
});

describe('parseLead: normalisation and caps', () => {
  it('trims every field', () => {
    const padded = Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, `  ${v} `]));
    expect(parseOrThrow(padded)).toEqual(valid);
  });

  it('drops unknown keys, including any attempt to choose the status or source', () => {
    const lead = parseOrThrow({ ...valid, campaign: 'spring', status: 'client', source: 'referral', full_name: 'X' });
    expect(lead).toEqual(valid);
  });

  it.each([['external_id', 128], ['first_name', 100], ['last_name', 100], ['phone', 40], ['business_name', 200], ['notes', 5000]] as const)(
    'refuses %s over %i characters',
    (key, max) => {
      expect(parseLead({ ...valid, [key]: 'x'.repeat(max + 1) }).ok).toBe(false);
      expect(parseLead({ ...valid, [key]: 'x'.repeat(max) }).ok).toBe(true);
    },
  );
});

describe('lead email addresses', () => {
  it.each(['ada@example.com', "o'neil+leads@sub.example.co.uk"])('accepts %s', (e) => expect(isValidLeadEmail(e)).toBe(true));
  // The address reaches an email header and a mailto: link, where a newline is injection.
  it.each(['ada@example.com\r\nBcc: someone@example.com', 'ada@example.com\nSubject: hi', 'ada@example.com' + String.fromCharCode(0)])(
    'refuses CR/LF/NUL %j',
    (e) => expect(isValidLeadEmail(e)).toBe(false),
  );
  it.each(['', 'not-an-email', 'a@', '@b.com', 'a b@c.com', `${'a'.repeat(250)}@b.com`])('refuses %j', (e) => expect(isValidLeadEmail(e)).toBe(false));
});

describe('the note and the owner notice', () => {
  it('the note carries the delivery id, the business, the phone and the notes, and fits the notes cap', () => {
    expect(leadNoteBody(parseOrThrow(valid))).toBe(
      'Lead received through lead intake (delivery LD-10021).\nBusiness: Acme LLC\nPhone: 555-0134\n\nNotes from the sender (not verified):\nWants a monthly retainer.',
    );
    expect(leadNoteBody(parseOrThrow({ external_id: 'LD-1', first_name: 'Ada', email: 'ada@example.com' }))).toBe(
      'Lead received through lead intake (delivery LD-1).',
    );
    expect(leadNoteBody(parseOrThrow({ ...valid, notes: 'n'.repeat(5000) })).length).toBeLessThan(10_000);
  });

  it('the subject names the first name only, never the address', () => {
    const lead = parseOrThrow(valid);
    expect(leadNotification(lead, true, null).subject).toBe('New lead: Ada');
    expect(leadNotification(lead, false, null).subject).toBe('A lead you already have: Ada');
    expect(leadNotification(lead, true, null).subject).not.toContain('@');
  });

  it("labels the sender's notes as unverified in the owner's notice, new lead or match", () => {
    for (const created of [true, false]) {
      const { content } = leadNotification(parseOrThrow(valid), created, null);
      expect(content.blocks).toContainEqual({ kind: 'paragraph', text: 'Notes from the sender (not verified):\nWants a monthly retainer.' });
    }
  });

  it('links the contact when the site is known', () => {
    const { content } = leadNotification(parseOrThrow(valid), true, 'https://crm.example.com/contacts/x');
    expect(content.blocks).toContainEqual({ kind: 'button', label: 'Open the contact', url: 'https://crm.example.com/contacts/x' });
  });
});

describe('the key', () => {
  it('is lik_ and 32 random bytes in base64url', () => {
    const key = newLeadIntakeKey();
    expect(key).toMatch(/^lik_[A-Za-z0-9_-]{43}$/);
    expect(newLeadIntakeKey()).not.toBe(key);
  });

  it('sha256Hex is the standard digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is read from x-api-key, a Bearer value or a bare Authorization value, and only at a sane length', () => {
    const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
    expect(presentedKey(req({ 'x-api-key': KEY }))).toBe(KEY);
    expect(presentedKey(req({ Authorization: `Bearer ${KEY}` }))).toBe(KEY);
    expect(presentedKey(req({ Authorization: KEY }))).toBe(KEY);
    expect(presentedKey(req({ 'x-api-key': 'short' }))).toBeNull();
    expect(presentedKey(req({ 'x-api-key': 'x'.repeat(201) }))).toBeNull();
    expect(presentedKey(req({}))).toBeNull();
  });
});

describe('createKeyVerifier', () => {
  it('accepts the key whose digest is stored and nothing else; no row refuses everything', async () => {
    const stored = await sha256Hex(KEY);
    expect(await createKeyVerifier({ loadKeyHash: async () => stored }).verify(KEY)).toBe(true);
    expect(await createKeyVerifier({ loadKeyHash: async () => stored }).verify(`${KEY}x`)).toBe(false);
    expect(await createKeyVerifier({ loadKeyHash: async () => null }).verify(KEY)).toBe(false);
    expect(await createKeyVerifier({ loadKeyHash: async () => 'not-a-digest' }).verify(KEY)).toBe(false);
  });

  it('reads the database at most once a minute, a missing key included, and never for an absent key', async () => {
    let clock = 0;
    const load = vi.fn(async () => null);
    const verifier = createKeyVerifier({ loadKeyHash: load, now: () => clock });
    await verifier.verify(null);
    expect(load).not.toHaveBeenCalled();
    await verifier.verify(KEY);
    await verifier.verify(KEY);
    expect(load).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await verifier.verify(KEY);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a replaced key keeps working until the cache expires, then stops', async () => {
    let clock = 0;
    let stored = await sha256Hex(KEY);
    const verifier = createKeyVerifier({ loadKeyHash: async () => stored, now: () => clock });
    expect(await verifier.verify(KEY)).toBe(true);
    stored = await sha256Hex(`${KEY}-new`);
    clock = 59_999;
    expect(await verifier.verify(KEY)).toBe(true);
    clock = 60_000;
    expect(await verifier.verify(KEY)).toBe(false);
    expect(await verifier.verify(`${KEY}-new`)).toBe(true);
  });

  it('a failed read throws and is not cached', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(await sha256Hex(KEY));
    const verifier = createKeyVerifier({ loadKeyHash: load });
    await expect(verifier.verify(KEY)).rejects.toThrow('db down');
    expect(await verifier.verify(KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The endpoint.
// ---------------------------------------------------------------------------

function fakeDeps(over: Partial<LeadIntakeDeps> = {}): LeadIntakeDeps {
  return {
    allowedOrigins: ['http://localhost:5173'],
    siteUrl: null,
    loadKeyHash: () => sha256Hex(KEY),
    rateLimit: async () => 'allowed',
    record: async () => ({ status: 'created', contact_id: '10000000-0000-4000-8000-000000000001' }),
    notifyOwner: async () => true,
    ...over,
  };
}

describeEdgeContract({
  name: 'lead-intake',
  handler: createLeadIntakeHandler(fakeDeps()),
  failingHandler: createLeadIntakeHandler(fakeDeps({ record: throwInternal })),
  limitedHandler: createLeadIntakeHandler(fakeDeps({ rateLimit: async () => 'limited' })),
  credentials: { 'x-api-key': KEY },
  body: { kind: 'json', valid, maxBytes: 20_000 },
});

describe('lead-intake: the key comes first', () => {
  it('a wrong or missing key is 401 before the limiter, the body or the database, once the cache is warm', async () => {
    const loadKeyHash = vi.fn(() => sha256Hex(KEY));
    const rateLimit = vi.fn(async () => 'allowed' as const);
    const record = vi.fn(async (): Promise<RecordResult> => ({ status: 'created' }));
    const handler = createLeadIntakeHandler(fakeDeps({ loadKeyHash, rateLimit, record }));
    expect((await handler(edgeRequest({ origin: null, headers: { 'x-api-key': KEY }, body: valid }))).status).toBe(202);
    loadKeyHash.mockClear();
    rateLimit.mockClear();
    record.mockClear();

    for (const headers of [{ 'x-api-key': `${KEY}x` }, { Authorization: 'Bearer nope-nope-nope-nope-nope' }, {}] as Record<string, string>[]) {
      const res = await handler(edgeRequest({ origin: null, headers, body: '{not json' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: REFUSALS.unauthenticated.error, code: REFUSALS.unauthenticated.code });
    }
    expect(loadKeyHash).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a key that cannot be checked is 503, never let through', async () => {
    const record = vi.fn();
    const handler = createLeadIntakeHandler(fakeDeps({ loadKeyHash: async () => { throw new Error('db down'); }, record }));
    const res = await handler(edgeRequest({ origin: null, headers: { 'x-api-key': KEY }, body: valid }));
    expect(res.status).toBe(503);
    expect(record).not.toHaveBeenCalled();
  });

  it('takes the key in all three header forms', async () => {
    const handler = createLeadIntakeHandler(fakeDeps());
    for (const headers of [{ 'x-api-key': KEY }, { Authorization: `Bearer ${KEY}` }, { Authorization: KEY }] as Record<string, string>[]) {
      expect((await handler(edgeRequest({ origin: null, headers, body: valid }))).status).toBe(202);
    }
  });

  it('a 400 names the bad field and stores nothing', async () => {
    const record = vi.fn();
    const handler = createLeadIntakeHandler(fakeDeps({ record }));
    const res = await handler(edgeRequest({ origin: null, headers: { 'x-api-key': KEY }, body: { ...valid, email: 'nope' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Field "email" is not a valid email address.', code: 'invalid_lead' });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('lead-intake: against the database', () => {
  let db: PGlite;
  let logs: string[];
  let notices: Array<{ subject: string; idempotencyKey: string }>;

  beforeEach(async () => {
    db = await createDb();
    await seedCore(db);
    await db.query(`INSERT INTO public.lead_intake_keys (key_hash, key_hint) VALUES ($1, 'lik_kkkk')`, [await sha256Hex(KEY)]);
    logs = [];
    notices = [];
  }, 60_000);

  function dbDeps(over: Partial<LeadIntakeDeps> = {}): LeadIntakeDeps {
    const server = serviceClient(db);
    return {
      allowedOrigins: ['http://localhost:5173'],
      siteUrl: 'https://crm.example.com',
      async loadKeyHash() {
        const { rows } = await db.query<{ key_hash: string }>('SELECT key_hash FROM public.lead_intake_keys');
        return rows[0]?.key_hash ?? null;
      },
      rateLimit: (ip, userAgent) => checkPublicLimits(server, { action: 'lead_intake', ip, userAgent, perIp: { max: 30, windowMinutes: 10 }, global: { max: 60, windowMinutes: 10 } }),
      async record(lead, note) {
        const { data, error } = await server.rpc('lead_intake_record', {
          p_external_id: lead.external_id, p_first_name: lead.first_name, p_last_name: lead.last_name, p_email: lead.email,
          p_phone: lead.phone, p_business_name: lead.business_name, p_note: note,
        });
        if (error) throw new Error(error.message);
        return data as RecordResult;
      },
      async notifyOwner(message) {
        notices.push({ subject: message.subject, idempotencyKey: message.idempotencyKey });
        return true;
      },
      logSink: (_level, line) => logs.push(line),
      ...over,
    };
  }

  const post = (handler: (req: Request) => Promise<Response>, body: unknown) =>
    handler(edgeRequest({ origin: null, headers: { 'x-api-key': KEY }, body }));
  const rows = async <T,>(sql: string) => (await db.query<T>(sql)).rows;

  it('the key first, then one rate-limit call (address, then global), all before the body is read', async () => {
    const server = serviceClient(db);
    const calls: string[] = [];
    const counting = {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        calls.push(`${fn}:${String(args?.p_action)}`);
        return server.rpc(fn, args);
      },
    };
    const record = vi.fn(async (): Promise<RecordResult> => ({ status: 'created' }));
    const handler = createLeadIntakeHandler(
      dbDeps({
        record,
        rateLimit: (ip, userAgent) =>
          checkPublicLimits(counting, { action: 'lead_intake', ip, userAgent, perIp: { max: 2, windowMinutes: 10 }, global: { max: 3, windowMinutes: 10 } }),
      }),
    );
    const send = (ip: string, key = KEY) =>
      handler(edgeRequest({ origin: null, headers: { 'x-api-key': key, 'x-forwarded-for': ip }, body: '{not json' }));
    // What the one call recorded: the address rows by address, and the shared rows.
    const buckets = async () => ({
      ip: Object.fromEntries(
        (await rows<{ ip: string; n: number }>(
          `SELECT host(ip_address) AS ip, count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'lead_intake.ip' GROUP BY 1`,
        )).map((r) => [r.ip, r.n]),
      ),
      global: (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'lead_intake.global'`))[0].n,
    });

    // A wrong key never reaches the limiter.
    expect((await send('203.0.113.7', `${KEY}x`)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(await buckets()).toEqual({ ip: {}, global: 0 });
    // A right key runs exactly one call, which records the address and the shared row.
    expect((await send('203.0.113.7')).status).toBe(400);
    expect(calls).toEqual(['check_public_rate_limit:lead_intake']);
    expect((await send('203.0.113.7')).status).toBe(400);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2 }, global: 2 });
    // The third from one address stops at its own bucket: it records nothing and spends none
    // of the shared ceiling.
    expect((await send('203.0.113.7')).status).toBe(429);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2 }, global: 2 });
    expect((await send('198.51.100.9')).status).toBe(400);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2, '198.51.100.9': 1 }, global: 3 });
    // A fresh address is stopped by the shared ceiling, and leaves no address row behind.
    expect((await send('192.0.2.44')).status).toBe(429);
    expect(await buckets()).toEqual({ ip: { '203.0.113.7': 2, '198.51.100.9': 1 }, global: 3 });
    // One call per keyed request; nothing ever reached the body.
    expect(calls).toHaveLength(5);
    expect(record).not.toHaveBeenCalled();
  });

  it('records a new lead, with constant status and source whatever the payload says, and tells the owner', async () => {
    const res = await post(createLeadIntakeHandler(dbDeps()), { ...valid, status: 'client', source: 'referral' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(await rows('SELECT status, source, first_name, email FROM public.contacts')).toEqual([
      { status: 'new_lead', source: 'lead_intake', first_name: 'Ada', email: 'ada@example.com' },
    ]);
    expect(await rows('SELECT count(*)::int AS n FROM public.contact_notes')).toEqual([{ n: 1 }]);
    expect(notices).toEqual([{ subject: 'New lead: Ada', idempotencyKey: 'lead-intake:LD-10021' }]);
  });

  it('answers created, matched and replayed with the same body', async () => {
    const handler = createLeadIntakeHandler(dbDeps());
    const created = await post(handler, valid);
    const matched = await post(handler, { ...valid, external_id: 'LD-10022' });
    const replayed = await post(handler, valid);
    const bodies = await Promise.all([created, matched, replayed].map(async (r) => [r.status, await r.text()]));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM public.contact_notes')).toEqual([{ n: 2 }]);
    // The note a match leaves on the existing contact labels the sender's text as unverified.
    const matchNote = await rows<{ body: string }>("SELECT body FROM public.contact_notes WHERE body LIKE '%delivery LD-10022%'");
    expect(matchNote).toHaveLength(1);
    expect(matchNote[0].body).toContain('\n\nNotes from the sender (not verified):\nWants a monthly retainer.');
    // A replay tells nobody twice.
    expect(notices.map((n) => n.subject)).toEqual(['New lead: Ada', 'A lead you already have: Ada']);
  });

  it('a redelivery after the contact was deleted is accepted and does not recreate it', async () => {
    const handler = createLeadIntakeHandler(dbDeps());
    await post(handler, valid);
    await db.exec('DELETE FROM public.contacts');
    expect((await post(handler, valid)).status).toBe(202);
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 0 }]);
  });

  it('a notice that fails is logged without the lead in the line; the lead stays recorded', async () => {
    for (const notifyOwner of [async () => false, async () => { throw new Error('send to ada@example.com failed'); }]) {
      logs = [];
      const handler = createLeadIntakeHandler(dbDeps({ notifyOwner }));
      const res = await post(handler, { ...valid, external_id: `LD-${logs.length}${Math.random().toString(36).slice(2, 8)}` });
      expect(res.status).toBe(202);
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain('ada@example.com');
        expect(line).not.toContain('Lovelace');
        expect(line).not.toContain('555-0134');
      }
    }
    expect(await rows('SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 1 }]);
  });

  it('a deleted key refuses deliveries once the cache expires', async () => {
    let clock = 0;
    const handler = createLeadIntakeHandler(dbDeps({ now: () => clock }));
    expect((await post(handler, valid)).status).toBe(202);
    await db.exec('DELETE FROM public.lead_intake_keys');
    clock = 60_000;
    expect((await post(handler, { ...valid, external_id: 'LD-2' })).status).toBe(401);
  });

  it('the global bucket closes the endpoint after 60 deliveries in ten minutes', async () => {
    const handler = createLeadIntakeHandler(dbDeps({ record: async () => ({ status: 'replayed' }) }));
    await db.exec(`INSERT INTO public.auth_rate_limits (action) SELECT 'lead_intake.global' FROM generate_series(1, 60)`);
    const res = await post(handler, valid);
    expect(res.status).toBe(429);
  });
});
