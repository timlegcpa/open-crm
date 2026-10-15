// @vitest-environment node
// email-unsubscribe, run against the real migrations in PGlite, with the real limiter
// functions through the shared rate-limit module.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import {
  createUnsubscribeHandler,
  hashToken,
  JUNK_ACTION,
  tokenAction,
  UNSUBSCRIBE_LIMITS,
  unsubscribeLimits,
  type UnsubscribeDeps,
} from '../../../supabase/functions/email-unsubscribe/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { SECURITY_HEADERS } from '../../../supabase/functions/_shared/http';
import { describeEdgeContract, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = 'http://localhost:5173';
const SITE = 'https://crm.example.com';
const TOKEN = 'Abc_def-123'.repeat(4);
const USED_TOKEN = 'Used_token-9'.repeat(4);

let db: PGlite;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let out: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    out = (await tx.query<T>(sql, params)).rows;
  });
  return out;
}

type Limits = { [K in keyof typeof UNSUBSCRIBE_LIMITS]: { max: number; windowMinutes: number } };

/** Wired as index.ts wires it (the same unsubscribeLimits), with the production limits unless a test lowers one to fit. */
function deps(over: Partial<UnsubscribeDeps> = {}, lower: Partial<Limits> = {}): UnsubscribeDeps {
  const client = serviceClient(db);
  const limits: Limits = { ...UNSUBSCRIBE_LIMITS, ...lower };
  return {
    allowedOrigins: [ORIGIN],
    siteUrl: SITE,
    ...unsubscribeLimits(client, limits),
    lookup: async (hash) => (await asServer<{ s: 'invalid' | 'confirm' | 'unsubscribed' }>(`SELECT public.email_unsubscribe_lookup($1) AS s`, [hash]))[0].s,
    confirm: async (hash) => (await asServer<{ s: 'invalid' | 'unsubscribed' }>(`SELECT public.email_unsubscribe_confirm($1) AS s`, [hash]))[0].s,
    logSink: () => {},
    ...over,
  };
}

interface Init {
  method?: string;
  token?: string | null;
  json?: boolean;
  body?: BodyInit;
  headers?: Record<string, string>;
  origin?: string | null;
}

function request(init: Init = {}): Request {
  const url = new URL('http://edge.local/email-unsubscribe');
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) url.searchParams.set('t', token);
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7', ...init.headers };
  if (init.json !== false) headers.Accept = 'application/json';
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  return new Request(url, { method: init.method ?? 'GET', headers, body: init.body });
}

const call = (d: UnsubscribeDeps, init: Init = {}) => createUnsubscribeHandler(d)(request(init));
const stateOf = async (res: Response) => ((await res.json()) as { state?: string }).state;
const suppressions = () => rows<{ address: string; reason: string; source: string }>(`SELECT address, reason, source FROM public.email_suppressions`);
const usedAt = async (token: string) =>
  (await rows<{ used_at: string | null }>(`SELECT used_at FROM public.email_unsubscribe_tokens WHERE token_hash = $1`, [await hashToken(token)]))[0].used_at;

beforeEach(async () => {
  db = await createDb();
  await db.query(
    `INSERT INTO public.email_unsubscribe_tokens (token_hash, address, expires_at, used_at) VALUES
       ($1, ' Ada@Example.com', now() + interval '90 days', NULL),
       ($2, 'grace@example.com', now() + interval '90 days', now())`,
    [await hashToken(TOKEN), await hashToken(USED_TOKEN)],
  );
}, 60_000);

/**
 * The contract's requests carry no capability, so a handler that answers 410 at once would
 * never reach a dependency. These add the token to the query, as the email's link does.
 */
const withToken = (handler: (req: Request) => Promise<Response>) => async (req: Request) => {
  const url = new URL(req.url);
  url.searchParams.set('t', TOKEN);
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : await req.arrayBuffer();
  return handler(new Request(url, { method: req.method, headers: req.headers, body }));
};

describeEdgeContract({
  name: 'email-unsubscribe',
  get handler() {
    return withToken(createUnsubscribeHandler(deps()));
  },
  get failingHandler() {
    return withToken(createUnsubscribeHandler(deps({ confirm: throwInternal })));
  },
  get limitedHandler() {
    // The contract's request carries no token, so it is junk.
    return createUnsubscribeHandler(deps({ checkJunkLimit: async () => 'limited' }));
  },
  credentials: null,
  body: { kind: 'none' },
});

describe('email-unsubscribe: GET only asks', () => {
  it('answers confirm and writes nothing', async () => {
    const res = await call(deps());
    expect(res.status).toBe(200);
    expect(await stateOf(res)).toBe('confirm');
    expect(await suppressions()).toEqual([]);
    expect(await usedAt(TOKEN)).toBeNull();
  });

  it('answers unsubscribed for a token already used', async () => {
    expect(await stateOf(await call(deps(), { token: USED_TOKEN }))).toBe('unsubscribed');
  });

  it('sends a mail client to the page, which only asks', async () => {
    const confirm = vi.fn();
    const res = await call(deps({ confirm }), { json: false });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/unsubscribe?t=${TOKEN}`);
    expect(confirm).not.toHaveBeenCalled();
    expect(await suppressions()).toEqual([]);
  });

  it('with no site configured, a mail client gets a plain sentence', async () => {
    const res = await call(deps({ siteUrl: null }), { json: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
  });
});

describe('email-unsubscribe: POST opts out', () => {
  it('suppresses the address, normalized, and stamps the token', async () => {
    const res = await call(deps(), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await stateOf(res)).toBe('unsubscribed');
    expect(await suppressions()).toEqual([{ address: 'ada@example.com', reason: 'unsubscribed', source: 'unsubscribe_link' }]);
    expect(await usedAt(TOKEN)).not.toBeNull();
  });

  it('a second POST still succeeds, and writes nothing new', async () => {
    await call(deps(), { method: 'POST' });
    const again = await call(deps(), { method: 'POST' });
    expect(await stateOf(again)).toBe('unsubscribed');
    expect(await suppressions()).toHaveLength(1);
  });

  it('an old token still opts out', async () => {
    await db.exec(`UPDATE public.email_unsubscribe_tokens SET expires_at = now() - interval '2 years'`);
    expect(await stateOf(await call(deps(), { method: 'POST' }))).toBe('unsubscribed');
  });

  it('RFC 8058 one-click: the provider POSTs List-Unsubscribe=One-Click with the token in the query', async () => {
    const res = await call(deps(), {
      method: 'POST',
      json: false,
      origin: null,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Unsubscribed.');
    expect(await suppressions()).toHaveLength(1);
  });

  it('reads the token from a urlencoded body when the query has none', async () => {
    const res = await call(deps(), {
      method: 'POST',
      token: null,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `t=${TOKEN}`,
    });
    expect(await stateOf(res)).toBe('unsubscribed');
  });

  it('refuses a body over 4 KiB as an unreadable link, without suppressing anything', async () => {
    const res = await call(deps(), { method: 'POST', token: null, body: `t=${TOKEN}&pad=${'x'.repeat(5000)}` });
    expect(res.status).toBe(410);
    expect(await stateOf(res)).toBe('invalid');
    expect(await suppressions()).toEqual([]);
  });
});

describe('email-unsubscribe: never says whether an address is known', () => {
  it('malformed, unknown, over-long and missing tokens all read invalid (410)', async () => {
    for (const token of ['has spaces', 'x'.repeat(201), 'Unknown_token-1'.repeat(3), null, '<script>']) {
      for (const method of ['GET', 'POST']) {
        const res = await call(deps(), { method, token });
        expect([token, method, res.status, await stateOf(res)]).toEqual([token, method, 410, 'invalid']);
      }
    }
    expect(await suppressions()).toEqual([]);
  });
});

const JUNK = 'Unknown_token-1'.repeat(3);
const ONE_CLICK: Init = {
  method: 'POST',
  json: false,
  origin: null,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'List-Unsubscribe=One-Click',
};
const from = (ip: string, init: Init = {}): Init => ({ ...init, headers: { ...init.headers, 'cf-connecting-ip': ip } });
const bucketRows = async (action: string) =>
  (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE action = $1`, [action]))[0].n;

/** A POST whose body records whether anyone read it. */
function streamedPost(query: string | null, ip = '203.0.113.7'): { req: Request; pulled: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true;
      controller.enqueue(new TextEncoder().encode(`t=${TOKEN}`));
      controller.close();
    },
    // Nothing is pulled until someone reads: a default stream fills its queue at once.
  }, { highWaterMark: 0 });
  const url = new URL('http://edge.local/email-unsubscribe');
  if (query !== null) url.searchParams.set('t', query);
  const req = new Request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', Origin: ORIGIN, 'cf-connecting-ip': ip },
    body,
    // @ts-expect-error: Node needs half-duplex for a streamed body; the DOM types lack it.
    duplex: 'half',
  });
  return { req, pulled: () => pulled };
}

const OTHER_TOKEN = 'Other_token-7'.repeat(4);

const JUNK_IP = `${JUNK_ACTION}.ip`;
const JUNK_GLOBAL = `${JUNK_ACTION}.global`;
const allRows = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.auth_rate_limits`))[0].n;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

describe('email-unsubscribe: rate limits, in order', () => {
  it('the production numbers: generous per address (pooled provider egress), tight per token', () => {
    expect(UNSUBSCRIBE_LIMITS.perIp.max).toBeGreaterThanOrEqual(300);
    expect(UNSUBSCRIBE_LIMITS.perToken.max).toBe(10);
    expect(UNSUBSCRIBE_LIMITS.junk.max).toBe(2000);
  });

  it('a. the lookup is a read: a request refused at its limit writes nothing at all', async () => {
    const d = deps({ checkJunkLimit: async () => 'limited', checkTokenLimit: async () => 'limited' });
    for (const init of [{}, { method: 'POST' }, { token: JUNK }, { method: 'POST', token: null }]) {
      const res = await call(d, init);
      expect([init, res.status]).toEqual([init, 429]);
    }
    expect(await allRows()).toBe(0);
    expect(await suppressions()).toEqual([]);
    expect(await usedAt(TOKEN)).toBeNull();
  });

  it('a. a lookup that cannot answer is 503 and spends no bucket', async () => {
    const res = await call(deps({ lookup: throwInternal }), { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await allRows()).toBe(0);
  });

  it('b. one call per request: a real token spends its own action, never the junk one', async () => {
    await call(deps());
    await call(deps(), { method: 'POST' });
    await call(deps(), ONE_CLICK);
    const hash = await hashToken(TOKEN);
    expect(await bucketRows(`${tokenAction('view', hash)}.global`)).toBe(1);
    expect(await bucketRows(`${tokenAction('confirm', hash)}.global`)).toBe(2);
    expect(await bucketRows(`${tokenAction('confirm', hash)}.ip`)).toBe(2);
    expect([await bucketRows(JUNK_IP), await bucketRows(JUNK_GLOBAL)]).toEqual([0, 0]);
    expect(await allRows()).toBe(6);
  });

  it('b. the per-address limit bounds junk from one address, and a real token from it still works', async () => {
    const d = deps({}, { perIp: { max: 2, windowMinutes: 60 } });
    expect((await call(d, { token: JUNK })).status).toBe(410);
    expect((await call(d, { method: 'POST', token: JUNK })).status).toBe(410);
    expect((await call(d, { token: JUNK })).status).toBe(429);
    expect((await call(d)).status).toBe(200);
    expect(await bucketRows(JUNK_IP)).toBe(2);
  });

  it('b. a refused junk request writes no row: once the ceiling is spent, a fresh address commits nothing', async () => {
    const d = deps({}, { junk: { max: 1, windowMinutes: 60 } });
    expect((await call(d, from('198.51.100.1', { token: JUNK }))).status).toBe(410);
    expect((await call(d, from('198.51.100.2', { token: JUNK }))).status).toBe(429);
    expect((await call(d, from('198.51.100.3', { method: 'POST', token: null }))).status).toBe(429);
    expect([await bucketRows(JUNK_IP), await bucketRows(JUNK_GLOBAL)]).toEqual([1, 1]);
  });

  it('b. one token is limited alone: another token still works, and its GETs do not spend its POST', async () => {
    const d = deps({}, { perToken: { max: 2, windowMinutes: 60 } });
    await db.query(`INSERT INTO public.email_unsubscribe_tokens (token_hash, address, expires_at) VALUES ($1, 'katherine@example.com', now())`,
      [await hashToken(OTHER_TOKEN)]);
    for (let i = 0; i < 2; i++) expect((await call(d)).status).toBe(200);
    expect((await call(d)).status).toBe(429);
    expect((await call(d, { token: OTHER_TOKEN })).status).toBe(200);
    expect((await call(d, { method: 'POST' })).status).toBe(200);
  });

  it('b. a flood of junk from many addresses fills only the junk ceiling, and the real page and one-click still work', async () => {
    const d = deps({}, { junk: { max: 5, windowMinutes: 60 } });
    for (let i = 0; i < 5; i++) expect((await call(d, from(`198.51.100.${i + 1}`, { method: 'POST', token: JUNK }))).status).toBe(410);
    // Junk from a fresh address is now refused: the shared ceiling holds, and writes nothing.
    expect((await call(d, from('198.51.100.99', { token: JUNK }))).status).toBe(429);
    expect((await call(d, from('198.51.100.98', { method: 'POST', token: null }))).status).toBe(429);
    expect([await bucketRows(JUNK_IP), await bucketRows(JUNK_GLOBAL)]).toEqual([5, 5]);
    // A real link, page and one-click alike, still works.
    expect(await stateOf(await call(d, from('198.51.100.100')))).toBe('confirm');
    const res = await call(d, from('198.51.100.101', ONE_CLICK));
    expect([res.status, await res.text()]).toEqual([200, 'Unsubscribed.']);
    expect(await suppressions()).toHaveLength(1);
  });

  it('c. no body is read before the limit decides, with or without a query token', async () => {
    for (const query of [JUNK, null]) {
      const { req, pulled } = streamedPost(query);
      const res = await createUnsubscribeHandler(deps({ checkJunkLimit: async () => 'limited' }))(req);
      expect([query, res.status, pulled()]).toEqual([query, 429, false]);
    }
    const { req, pulled } = streamedPost(TOKEN);
    const res = await createUnsubscribeHandler(deps({ checkTokenLimit: async () => 'limited' }))(req);
    expect([res.status, pulled()]).toEqual([429, false]);
  });

  it('c. a body token is read only after the junk call allowed it, and then spends its own', async () => {
    const res = await call(deps(), { method: 'POST', token: null, headers: FORM, body: `t=${TOKEN}` });
    expect(await stateOf(res)).toBe('unsubscribed');
    expect([await bucketRows(JUNK_IP), await bucketRows(JUNK_GLOBAL)]).toEqual([1, 1]);
    expect(await bucketRows(`${tokenAction('confirm', await hashToken(TOKEN))}.global`)).toBe(1);
  });

  it('c. a body token over its own limit is refused and not confirmed', async () => {
    const confirm = vi.fn();
    const res = await call(deps({ confirm, checkTokenLimit: async () => 'limited' }), { method: 'POST', token: null, headers: FORM, body: `t=${TOKEN}` });
    expect(res.status).toBe(429);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('any limiter that cannot answer is 503, never a pass, and nothing is confirmed', async () => {
    const unavailable = async () => 'unavailable' as const;
    const cases: Array<[Partial<UnsubscribeDeps>, Init]> = [
      [{ checkTokenLimit: unavailable }, { method: 'POST' }],
      [{ checkJunkLimit: unavailable }, { method: 'POST', token: JUNK }],
      [{ checkJunkLimit: unavailable }, { method: 'POST', token: null, headers: FORM, body: `t=${TOKEN}` }],
      [{ checkTokenLimit: unavailable }, { method: 'POST', token: null, headers: FORM, body: `t=${TOKEN}` }],
    ];
    for (const [over, init] of cases) {
      const confirm = vi.fn();
      const res = await call(deps({ ...over, confirm }), init);
      expect([init.token, res.status]).toEqual([init.token, 503]);
      expect(await res.json()).toMatchObject({ code: 'unavailable' });
      expect(confirm).not.toHaveBeenCalled();
    }
    expect(await suppressions()).toEqual([]);
  });

  it('the real limiter failing is 503 too, on both paths', async () => {
    const broken = { rpc: async () => ({ data: null, error: new Error('down') }) };
    const d = deps(unsubscribeLimits(broken));
    expect((await call(d, { method: 'POST' })).status).toBe(503);
    expect((await call(d, { token: JUNK })).status).toBe(503);
    expect(await suppressions()).toEqual([]);
  });
});

describe('email-unsubscribe: headers', () => {
  it('every response carries the security headers and noindex, preflights and refusals included', async () => {
    const responses = [
      await call(deps()),
      await call(deps(), { method: 'OPTIONS' }),
      await call(deps(), { method: 'PUT' }),
      await call(deps(), { token: 'bad token' }),
      await call(deps(), { json: false }),
      await call(deps({ checkJunkLimit: async () => 'limited' }), { token: JUNK }),
      await call(deps({ checkTokenLimit: async () => 'limited' })),
      await call(deps({ lookup: throwInternal })),
    ];
    for (const res of responses) {
      expect([res.status, res.headers.get('X-Robots-Tag')]).toEqual([res.status, 'noindex, nofollow']);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) expect([res.status, key, res.headers.get(key)]).toEqual([res.status, key, value]);
    }
  });
});

describe('the two functions hash a token the same way', () => {
  it('so a token minted by the send is found by the unsubscribe', async () => {
    expect(await hashToken(TOKEN)).toBe(await sha256Hex(TOKEN));
    expect(await hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});
