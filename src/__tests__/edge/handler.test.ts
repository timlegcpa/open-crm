// @vitest-environment node
// createHandler, the request pipeline every edge function runs: the shared contract
// against one sample function per auth mode, then the cases the contract cannot see
// (mode combinations, body kinds, a function's own Response, startup refusals).
import { describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  HttpError,
  refuseImpersonation,
  REFUSALS,
  type AuthModes,
  type BodyKind,
  type HandlerContext,
  type HandlerOptions,
  type Principal,
} from '../../../supabase/functions/_shared/handler';
import type { LogLevel } from '../../../supabase/functions/_shared/log';
import type { RateLimitOutcome } from '../../../supabase/functions/_shared/rate-limit';
import {
  ALLOWED_ORIGIN,
  CLIENT_CONTACT_ID,
  CREDENTIALS,
  CRON_SECRET,
  describeEdgeContract,
  edgeRequest,
  expectEdgeHeaders,
  fakeClientAuth,
  fakeOwnerAuth,
  INTERNAL_HEADER,
  INTERNAL_SECRET,
  OWNER_ID,
  OWNER_TOKEN,
  throwInternal,
} from './contract';

const ok = async (ctx: HandlerContext<Principal, unknown>) => ctx.json(200, { kind: ctx.principal.kind, body: ctx.body ?? null });

function sample<A extends AuthModes, K extends BodyKind = 'json'>(
  over: Partial<HandlerOptions<A, K>> & { auth: A },
): (req: Request) => Promise<Response> {
  return createHandler<A, K>({
    name: 'sample',
    allowedOrigins: [ALLOWED_ORIGIN],
    maxBodyBytes: 256,
    handle: ok as HandlerOptions<A, K>['handle'],
    logSink: () => {},
    ...over,
  });
}

describeEdgeContract({
  name: 'owner function',
  handler: sample({ auth: { owner: fakeOwnerAuth() } }),
  failingHandler: sample({ auth: { owner: fakeOwnerAuth() }, handle: throwInternal }),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { a: 1 }, maxBytes: 256 },
});

describeEdgeContract({
  name: 'client write function',
  handler: sample({ auth: { client: fakeClientAuth() }, clientWrites: true }),
  failingHandler: sample({ auth: { client: fakeClientAuth() }, clientWrites: true, handle: throwInternal }),
  credentials: CREDENTIALS.client,
  wrongPrincipal: CREDENTIALS.owner,
  clientWrites: true,
  body: { kind: 'json', valid: { a: 1 }, maxBytes: 256 },
});

describeEdgeContract({
  name: 'cron function',
  handler: sample({ auth: { cron: { secret: CRON_SECRET } }, body: 'none' }),
  failingHandler: sample({ auth: { cron: { secret: CRON_SECRET } }, body: 'none', handle: throwInternal }),
  credentials: CREDENTIALS.cron,
  body: { kind: 'none' },
});

describeEdgeContract({
  name: 'internal function',
  handler: sample({ auth: { internal: { header: INTERNAL_HEADER, secret: INTERNAL_SECRET } } }),
  failingHandler: sample({ auth: { internal: { header: INTERNAL_HEADER, secret: INTERNAL_SECRET } }, handle: throwInternal }),
  credentials: CREDENTIALS.internal,
  body: { kind: 'json', valid: { a: 1 }, maxBytes: 256 },
});

const publicFn = (outcome: RateLimitOutcome, handle = ok) =>
  sample({ auth: { public: true }, rateLimit: async () => outcome, handle: handle as never });
describeEdgeContract({
  name: 'public function',
  handler: publicFn('allowed'),
  failingHandler: publicFn('allowed', throwInternal),
  limitedHandler: publicFn('limited'),
  credentials: null,
  body: { kind: 'json', valid: { a: 1 }, maxBytes: 256 },
});

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

describe('createHandler: combined modes', () => {
  const cronOrOwner = sample({ auth: { cron: { secret: CRON_SECRET }, owner: fakeOwnerAuth() }, body: 'none' });

  it('cron + owner: each credential reaches its own principal', async () => {
    expect(await bodyOf(await cronOrOwner(edgeRequest({ origin: null, headers: CREDENTIALS.cron })))).toMatchObject({ kind: 'cron' });
    expect(await bodyOf(await cronOrOwner(edgeRequest({ headers: CREDENTIALS.owner })))).toMatchObject({ kind: 'owner' });
  });

  it('a wrong secret header is refused on its own, not retried as the bearer', async () => {
    const res = await cronOrOwner(edgeRequest({ headers: { ...CREDENTIALS.owner, 'x-cron-secret': 'w'.repeat(64) } }));
    expect(res.status).toBe(401);
  });

  it('owner + client: the owner token is the owner, the client token the client, a dead one 401', async () => {
    const either = sample({ auth: { owner: fakeOwnerAuth(), client: fakeClientAuth() } });
    const body = { a: 1 };
    expect(await bodyOf(await either(edgeRequest({ headers: CREDENTIALS.owner, body })))).toMatchObject({ kind: 'owner' });
    expect(await bodyOf(await either(edgeRequest({ headers: CREDENTIALS.client, body })))).toMatchObject({ kind: 'client' });
    expect((await either(edgeRequest({ headers: { Authorization: 'Bearer dead' }, body }))).status).toBe(401);
  });

  it('a View-as-client session can read where clientWrites is off, and sees impersonating', async () => {
    const reader = sample({
      auth: { client: fakeClientAuth() },
      handle: async (ctx) => ctx.json(200, ctx.principal.kind === 'client' ? ctx.principal : null),
    });
    const res = await reader(edgeRequest({ headers: CREDENTIALS.viewAsClient, body: {} }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ contactId: CLIENT_CONTACT_ID, impersonating: true });
  });
});

describe('createHandler: authentication', () => {
  it('treats a throwing authorizer as signed out, logs it, and never calls handle', async () => {
    const lines: string[] = [];
    const handle = vi.fn(ok);
    const fn = sample({
      auth: { owner: async () => { throw new Error('auth unreachable'); } },
      handle,
      logSink: (_level: LogLevel, line: string) => lines.push(line),
    });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(res.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('authorization failed');
  });

  it('refuses an over-long token without asking the authorizer', async () => {
    const owner = vi.fn(fakeOwnerAuth());
    const fn = sample({ auth: { owner } });
    const res = await fn(edgeRequest({ headers: { Authorization: `Bearer ${'t'.repeat(8193)}` }, body: {} }));
    expect(res.status).toBe(401);
    expect(owner).not.toHaveBeenCalled();
  });

  it('refuses every cron call when the secret is unset or too short, and says why in the log', async () => {
    for (const secret of [undefined, '', 'c'.repeat(31)]) {
      const lines: string[] = [];
      const fn = sample({ auth: { cron: { secret } }, body: 'none', logSink: (_l: LogLevel, line: string) => lines.push(line) });
      const presented = secret || 'c'.repeat(31);
      const res = await fn(edgeRequest({ origin: null, headers: { 'x-cron-secret': presented } }));
      expect([secret, res.status]).toEqual([secret, 401]);
      if (!secret) expect(lines.join('\n')).toContain('CRON_SHARED_SECRET is not set');
    }
  });

  it('accepts a server-to-server call with no Origin, and grants no CORS', async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() } });
    const res = await fn(edgeRequest({ origin: null, headers: CREDENTIALS.owner, body: {} }));
    expect(res.status).toBe(200);
    expectEdgeHeaders(res, null);
  });

  it('hands the bearer token and the caller address to handle', async () => {
    const fn = sample({
      auth: { owner: fakeOwnerAuth() },
      handle: async (ctx) => ctx.json(200, { token: ctx.token, ip: ctx.ip, userId: ctx.principal.userId }),
    });
    const res = await fn(edgeRequest({ headers: { ...CREDENTIALS.owner, 'cf-connecting-ip': '203.0.113.9' }, body: {} }));
    expect(await res.json()).toEqual({ token: OWNER_TOKEN, ip: '203.0.113.9', userId: OWNER_ID });
  });
});

describe('createHandler: rate limit', () => {
  it('answers 503 when the limiter is unavailable or throws, 429 when limited', async () => {
    expect((await publicFn('unavailable')(edgeRequest({ body: {} }))).status).toBe(503);
    expect((await publicFn('limited')(edgeRequest({ body: {} }))).status).toBe(429);
    const throwing = sample({ auth: { public: true }, rateLimit: async () => { throw new Error('db down'); } });
    const res = await throwing(edgeRequest({ body: {} }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: REFUSALS.unavailable.error, code: REFUSALS.unavailable.code });
  });

  it('runs after authentication: a refused caller never spends a bucket entry', async () => {
    const rateLimit = vi.fn(async (): Promise<RateLimitOutcome> => 'allowed');
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, rateLimit });
    expect((await fn(edgeRequest({ body: {} }))).status).toBe(401);
    expect(rateLimit).not.toHaveBeenCalled();
    await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit.mock.calls[0]).toHaveLength(1);
  });
});

describe('createHandler: body kinds', () => {
  it("'none' never reads the body", async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, body: 'none' });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: 'x'.repeat(10_000) }));
    expect(await res.json()).toEqual({ kind: 'owner', body: null });
  });

  it("'optional_json' reads an empty body as undefined and still refuses malformed JSON", async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, body: 'optional_json' });
    expect(await (await fn(edgeRequest({ headers: CREDENTIALS.owner }))).json()).toEqual({ kind: 'owner', body: null });
    expect(await (await fn(edgeRequest({ headers: CREDENTIALS.owner, body: { a: 2 } }))).json()).toEqual({ kind: 'owner', body: { a: 2 } });
    expect((await fn(edgeRequest({ headers: CREDENTIALS.owner, body: '{bad' }))).status).toBe(400);
  });

  it("'json' refuses an empty body", async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() } });
    expect((await fn(edgeRequest({ headers: CREDENTIALS.owner }))).status).toBe(400);
  });

  it("'bytes' hands over exactly the bytes sent, under the cap", async () => {
    const fn = sample({
      auth: { owner: fakeOwnerAuth() },
      body: 'bytes',
      handle: async (ctx) => ctx.json(200, { bytes: Array.from(ctx.body as Uint8Array) }),
    });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: new Uint8Array([0, 255, 37, 80]) }));
    expect(await res.json()).toEqual({ bytes: [0, 255, 37, 80] });
    expect((await fn(edgeRequest({ headers: CREDENTIALS.owner, body: new Uint8Array(257) }))).status).toBe(413);
  });

  it('a GET function with body none answers and advertises GET', async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, methods: ['GET'], body: 'none' });
    const res = await fn(edgeRequest({ method: 'GET', headers: CREDENTIALS.owner }));
    expect(res.status).toBe(200);
    const pre = await fn(edgeRequest({ method: 'OPTIONS' }));
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });
});

describe("createHandler: the function's own Response", () => {
  it('keeps its Content-Type and body, adds the headers, and drops any CORS header it set', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fn = sample({
      auth: { owner: fakeOwnerAuth() },
      handle: async () =>
        new Response(pdf, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'attachment' },
        }),
    });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
    expectEdgeHeaders(res);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(pdf));

    const fromElsewhere = await fn(edgeRequest({ origin: null, headers: CREDENTIALS.owner, body: {} }));
    expect(fromElsewhere.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('keeps a 204 with no body', async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, handle: async () => new Response(null, { status: 204 }) });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(res.status).toBe(204);
    expectEdgeHeaders(res);
  });

  it('turns an HttpError into its own status and public message', async () => {
    const fn = sample({
      auth: { owner: fakeOwnerAuth() },
      handle: async () => { throw new HttpError(409, 'Already done.', 'already_done'); },
    });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Already done.', code: 'already_done' });
    expectEdgeHeaders(res);
  });

  it('turns an HttpError with a non-error status into the generic 500', async () => {
    const fn = sample({ auth: { owner: fakeOwnerAuth() }, handle: async () => { throw new HttpError(200, 'fine'); } });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: REFUSALS.internal.error, code: REFUSALS.internal.code });
  });

  it('logs the cause of a 500 by summary and request id, and the body says nothing', async () => {
    const lines: string[] = [];
    const fn = sample({
      auth: { owner: fakeOwnerAuth() },
      handle: async () => { throw { code: '23505', message: 'duplicate key', details: 'Key (email)=(ada@example.test) already exists' }; },
      logSink: (_l: LogLevel, line: string) => lines.push(line),
      newRequestId: () => 'req-fixed-id',
    });
    const res = await fn(edgeRequest({ headers: CREDENTIALS.owner, body: {} }));
    expect(await res.text()).not.toContain('duplicate');
    expect(lines).toEqual(['[sample] rid=req-fixed-id unhandled error: [23505] duplicate key']);
  });
});

describe('createHandler: refuses to start misconfigured', () => {
  const handle = ok as never;
  const base = { name: 'bad', allowedOrigins: [ALLOWED_ORIGIN], handle };
  it.each([
    ['no auth mode', { ...base, auth: {} }, /at least one auth mode/],
    ['public plus owner', { ...base, auth: { public: true, owner: fakeOwnerAuth() }, rateLimit: async () => 'allowed' }, /cannot be combined/],
    ['public without a rate limit', { ...base, auth: { public: true } }, /must declare rateLimit/],
    ['clientWrites without the client mode', { ...base, auth: { owner: fakeOwnerAuth() }, clientWrites: true }, /clientWrites/],
    ['GET with a JSON body', { ...base, auth: { owner: fakeOwnerAuth() }, methods: ['GET'] }, /GET function/],
    ['an internal header that is not x-', { ...base, auth: { internal: { header: 'Authorization', secret: INTERNAL_SECRET } } }, /x- header/],
    ['a zero body cap', { ...base, auth: { owner: fakeOwnerAuth() }, maxBodyBytes: 0 }, /maxBodyBytes/],
  ])('%s', (_label, options, message) => {
    expect(() => createHandler(options as never)).toThrow(message);
  });
});

describe('refuseImpersonation', () => {
  it('throws the read-only refusal for a View-as-client session only', () => {
    const client = { kind: 'client' as const, userId: OWNER_ID, contactId: CLIENT_CONTACT_ID, sessionId: null };
    expect(() => refuseImpersonation({ ...client, impersonating: true })).toThrow(HttpError);
    expect(() => refuseImpersonation({ ...client, impersonating: false })).not.toThrow();
    expect(() => refuseImpersonation({ kind: 'owner', userId: OWNER_ID })).not.toThrow();
  });
});
