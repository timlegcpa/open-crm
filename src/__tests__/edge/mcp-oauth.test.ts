// @vitest-environment node
// mcp-oauth: each endpoint held to the edge contract, then the OAuth flow end to end
// against the real migrations (PGlite as service_role, functions called with named
// arguments, so a wrong parameter name is an error here as it would be in production).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, OWNER_ID as DB_OWNER_ID, seedCore, SYSTEM_ID } from '../db/harness';
import {
  ALLOWED_ORIGIN,
  CLIENT_TOKEN,
  CREDENTIALS,
  describeEdgeContract,
  fakeOwnerAuth,
  OWNER_TOKEN,
  throwInternal,
} from './contract';
import { serviceClient } from './pgliteClient';
import {
  ALLOWED_REDIRECT_URIS,
  authorizationServerMetadata,
  createMcpOauthEndpoints,
  createMcpOauthHandler,
  jwtAal,
  parseExtraRedirectUris,
  rejectedCallbacks,
  validRedirectUri,
  type McpOauthDeps,
} from '../../../supabase/functions/mcp-oauth/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { CLIENT_ID_RE, mcpResourceUrl, pkceChallenge } from '../../../supabase/functions/mcp-oauth/tokens';
import type { AuthOutcome, OwnerPrincipal } from '../../../supabase/functions/_shared/auth';

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const SITE = 'https://crm.example.com';
const RESOURCE = mcpResourceUrl(SUPABASE_URL);
const FN = `${SUPABASE_URL}/functions/v1/mcp-oauth`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_ID = 'mcpc_' + 'c'.repeat(43);
const VERIFIER = 'v'.repeat(64);
const AAL1_OWNER_TOKEN = 'contract-owner-aal1-token';

const sessionAal = (token: string) => (token === OWNER_TOKEN ? 'aal2' : token === AAL1_OWNER_TOKEN ? 'aal1' : null);

// ---------------------------------------------------------------------------
// The edge contract, per endpoint, with a fake database
// ---------------------------------------------------------------------------

function fakeDb(failing = false): McpOauthDeps['db'] {
  const answers: Record<string, unknown> = {
    mcp_oauth_pending_request: { request_id: 'r', client_name: 'Example assistant', redirect_uri: REDIRECT, scope: 'mcp:crm' },
    mcp_oauth_client: { redirect_uris: [REDIRECT] },
    mcp_oauth_rotate_refresh: { status: 'ok', scope: 'mcp:crm' },
    mcp_oauth_revoke_token: true,
    mcp_oauth_cleanup: null,
  };
  return {
    rpc: async (fn: string) => (failing ? throwInternal() : { data: answers[fn] ?? null, error: null }),
    from: () => ({ insert: async () => (failing ? throwInternal() : { error: null }) }),
  } as unknown as McpOauthDeps['db'];
}

function contractDeps(over: Partial<McpOauthDeps> = {}): McpOauthDeps {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    supabaseUrl: SUPABASE_URL,
    siteUrl: SITE,
    authorizeOwner: fakeOwnerAuth(),
    sessionAal,
    db: fakeDb(),
    limit: async () => 'allowed',
    ...over,
  };
}

const ok = createMcpOauthEndpoints(contractDeps());
const failing = createMcpOauthEndpoints(contractDeps({ db: fakeDb(true), siteUrl: null }));
const limited = createMcpOauthEndpoints(contractDeps({ limit: async () => 'limited' }));

/** The contract sends every request to one fixed URL; /authorize reads its query, so substitute a valid one. */
const AUTHORIZE_QUERY = new URLSearchParams({
  response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state: 'st',
  code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', scope: 'mcp:crm', resource: RESOURCE,
});
const atAuthorize = (h: (req: Request) => Promise<Response>) => (req: Request) =>
  h(new Request(`${FN}/authorize?${AUTHORIZE_QUERY}`, req));

describeEdgeContract({
  name: 'mcp-oauth consent',
  handler: ok.consent,
  failingHandler: failing.consent,
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'json', valid: { action: 'read', request_id: 'r' }, maxBytes: 1024 },
});
describeEdgeContract({
  name: 'mcp-oauth authorize',
  method: 'GET',
  handler: atAuthorize(ok.authorize),
  failingHandler: atAuthorize(createMcpOauthEndpoints(contractDeps({ db: fakeDb(true) })).authorize),
  limitedHandler: atAuthorize(limited.authorize),
  credentials: null,
  body: { kind: 'none' },
});
describeEdgeContract({
  name: 'mcp-oauth register',
  handler: ok.register,
  failingHandler: failing.register,
  limitedHandler: limited.register,
  credentials: null,
  body: { kind: 'json', valid: { redirect_uris: [REDIRECT], client_name: 'Example assistant' }, maxBytes: 10_000 },
});
describeEdgeContract({
  name: 'mcp-oauth token',
  handler: ok.token,
  failingHandler: failing.token,
  limitedHandler: limited.token,
  credentials: null,
  body: { kind: 'form', valid: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'mcprt_x' }), maxBytes: 10_000 },
});
describeEdgeContract({
  name: 'mcp-oauth revoke',
  handler: ok.revoke,
  failingHandler: failing.revoke,
  limitedHandler: limited.revoke,
  credentials: null,
  body: { kind: 'form', valid: new URLSearchParams({ token: 'mcprt_x' }), maxBytes: 10_000 },
});
describeEdgeContract({
  name: 'mcp-oauth metadata',
  method: 'GET',
  handler: ok.metadata,
  failingHandler: failing.metadata,
  limitedHandler: limited.metadata,
  credentials: null,
  body: { kind: 'none' },
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('validRedirectUri', () => {
  it('accepts each allowlisted callback exactly, and loopback over http', () => {
    for (const uri of ALLOWED_REDIRECT_URIS) expect(validRedirectUri(uri)).toBe(true);
    for (const uri of ['http://localhost:3334/callback', 'http://127.0.0.1/cb', 'http://[::1]:9000/cb?x=1']) {
      expect([uri, validRedirectUri(uri)]).toEqual([uri, true]);
    }
  });

  it.each([
    ['a query on an allowlisted callback', `${REDIRECT}?next=https://attacker.example`],
    ['another path on an allowlisted host', 'https://claude.ai/attacker/cb'],
    ['a fragment', `${REDIRECT}#x`],
    ['a bare trailing fragment mark', `${REDIRECT}#`],
    ['a bare trailing query mark', `${REDIRECT}?`],
    ['credentials in the URL', 'https://user:pw@claude.ai/api/mcp/auth_callback'],
    ['a look-alike host', 'https://claude.ai.attacker.example/api/mcp/auth_callback'],
    ['plain http to a public host', 'http://claude.ai/api/mcp/auth_callback'],
    ['https to loopback', 'https://localhost/cb'],
    ['a script URL', 'javascript:alert(1)'],
    ['an empty string', ''],
    ['not a string', 42],
    ['an overlong URL', `http://localhost/${'x'.repeat(500)}`],
  ])('refuses %s', (_label, uri) => {
    expect(validRedirectUri(uri)).toBe(false);
  });
});

describe('the adopter\u2019s extra callbacks', () => {
  const EXTRA = 'https://assistant.example.com/oauth/callback';

  it('parses exact https addresses, and refuses anything else without widening the list', () => {
    expect(parseExtraRedirectUris(undefined)).toEqual({ uris: [], rejected: [] });
    expect(parseExtraRedirectUris(` ${EXTRA} ,, https://Other.Example.com/cb `)).toEqual({
      uris: [EXTRA, 'https://other.example.com/cb'], rejected: [],
    });
    const parsed = parseExtraRedirectUris(
      `${EXTRA}?next=x, ${EXTRA}#, http://assistant.example.com/cb, https://user:pw@assistant.example.com/cb, not a url, ${EXTRA}?`,
    );
    expect(parsed.uris).toEqual([]);
    // Named by scheme, host and path only: never the query, credentials or fragment.
    expect(parsed.rejected).toEqual([
      'https://assistant.example.com/oauth/callback', 'https://assistant.example.com/oauth/callback',
      'http://assistant.example.com/cb', 'https://assistant.example.com/cb', '<unparseable>',
      'https://assistant.example.com/oauth/callback',
    ]);
  });

  it('an extra callback is valid only when configured, and only exactly', () => {
    const extra = new Set(parseExtraRedirectUris(EXTRA).uris);
    expect(validRedirectUri(EXTRA)).toBe(false);
    expect(validRedirectUri(EXTRA, extra)).toBe(true);
    for (const uri of [`${EXTRA}/more`, `${EXTRA}?x=1`, `${EXTRA}#`, 'https://assistant.example.com/', `http://assistant.example.com/oauth/callback`]) {
      expect([uri, validRedirectUri(uri, extra)]).toEqual([uri, false]);
    }
  });

  it('rejectedCallbacks names only the refused entries, by scheme, host and path', () => {
    expect(rejectedCallbacks([REDIRECT, 'https://new.example.com/cb?token=secret#frag', 42, null])).toEqual([
      'https://new.example.com/cb', '<number>', '<null>',
    ]);
    expect(rejectedCallbacks('https://user:pw@new.example.com/cb')).toEqual(['https://new.example.com/cb']);
    expect(rejectedCallbacks(Array(9).fill('nope'))).toHaveLength(5);
  });
});

describe('jwtAal', () => {
  const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  it('reads the aal claim, and is null for anything else', () => {
    expect(jwtAal(jwt({ aal: 'aal2' }))).toBe('aal2');
    expect(jwtAal(jwt({ aal: 'aal1' }))).toBe('aal1');
    expect(jwtAal(jwt({}))).toBeNull();
    expect(jwtAal(jwt({ aal: 2 }))).toBeNull();
    expect(jwtAal('no-dots')).toBeNull();
    expect(jwtAal('h.%%%.s')).toBeNull();
  });
});

describe('authorizationServerMetadata', () => {
  it('names the site as issuer, public clients, S256 only, and the function endpoints', () => {
    const m = authorizationServerMetadata(SITE, `${SUPABASE_URL}/`);
    expect(m).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${FN}/authorize`,
      token_endpoint: `${FN}/token`,
      registration_endpoint: `${FN}/register`,
      revocation_endpoint: `${FN}/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:crm'],
    });
  });
});

// ---------------------------------------------------------------------------
// The flow, against the real migrations
// ---------------------------------------------------------------------------

let db: PGlite;
beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
}, 60_000);

const NOT_OWNER_TOKEN = 'former-owner-token';

/** authorizeOwner bound to the seeded owner; NOT_OWNER_TOKEN passes as an owner session of someone the database says is not the owner. */
const dbOwnerAuth = async (token: string): Promise<AuthOutcome<OwnerPrincipal>> => {
  if (token === OWNER_TOKEN || token === AAL1_OWNER_TOKEN) return { ok: true, principal: { kind: 'owner', userId: DB_OWNER_ID } };
  if (token === NOT_OWNER_TOKEN) return { ok: true, principal: { kind: 'owner', userId: SYSTEM_ID } };
  return fakeOwnerAuth()(token);
};

function liveDeps(over: Partial<McpOauthDeps> = {}): McpOauthDeps {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    supabaseUrl: SUPABASE_URL,
    siteUrl: SITE,
    authorizeOwner: dbOwnerAuth,
    sessionAal: (t) => (t === NOT_OWNER_TOKEN ? 'aal2' : sessionAal(t)),
    db: serviceClient(db),
    limit: async () => 'allowed',
    ...over,
  };
}

let handler: (req: Request) => Promise<Response>;
beforeAll(() => {
  handler = createMcpOauthHandler(liveDeps());
});

/** A request to the function's subpath, as a connector sends it (no Origin) unless headers say otherwise. */
function at(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  let body: BodyInit | undefined;
  if (init.body instanceof URLSearchParams) body = init.body;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set('Content-Type', 'application/json');
  }
  return handler(new Request(`${FN}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body }));
}

const consent = (body: unknown, token = OWNER_TOKEN) =>
  at('', { headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN }, body });

async function register(name = 'Example assistant', uris = [REDIRECT]): Promise<string> {
  const res = await at('/register', { body: { redirect_uris: uris, client_name: name } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function park(clientId: string, over: Record<string, string> = {}): Promise<Response> {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'state-1',
    code_challenge: await pkceChallenge(VERIFIER), code_challenge_method: 'S256', scope: 'mcp:crm', resource: RESOURCE, ...over,
  });
  for (const [k, v] of Object.entries(over)) if (v === '<absent>') q.delete(k);
  return at(`/authorize?${q}`);
}

const requestIdOf = (res: Response) => new URL(res.headers.get('Location')!).searchParams.get('request')!;

/** register → authorize → approve, answering the code and the client id. */
async function approvedCode(): Promise<{ code: string; clientId: string }> {
  const clientId = await register();
  const requestId = requestIdOf(await park(clientId));
  const res = await consent({ action: 'decide', request_id: requestId, approve: true });
  const to = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
  return { code: to.searchParams.get('code')!, clientId };
}

const exchange = (params: Record<string, string>) => at('/token', { body: new URLSearchParams(params) });

async function tokens(): Promise<{ access_token: string; refresh_token: string; clientId: string }> {
  const { code, clientId } = await approvedCode();
  const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
  expect(res.status).toBe(200);
  return { ...((await res.json()) as { access_token: string; refresh_token: string }), clientId };
}

const liveGrant = async (accessToken: string) =>
  (await db.query(`SELECT public.mcp_oauth_authenticate($1) AS g`, [await sha256Hex(accessToken)])).rows[0] as { g: unknown };

describe('the router', () => {
  it('routes each subpath, and answers 404 for anything else, Object.prototype names included', async () => {
    expect((await at('/.well-known/oauth-authorization-server')).status).toBe(200);
    for (const path of ['/nope', '/constructor', '/__proto__', '/register/extra']) {
      const res = await at(path, { body: {} });
      expect([path, res.status]).toEqual([path, 404]);
    }
    const other = await handler(new Request(`${SUPABASE_URL}/functions/v1/mcp-oauthx/register`, { method: 'POST' }));
    expect(other.status).toBe(404);
  });

  it('serves the authorization server metadata', async () => {
    expect(await (await at('/.well-known/oauth-authorization-server')).json()).toEqual(authorizationServerMetadata(SITE, SUPABASE_URL));
  });
});

describe('/register', () => {
  it('registers a public client and stores it', async () => {
    const res = await at('/register', { body: { redirect_uris: [REDIRECT], client_name: 'Example\nassistant' } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(CLIENT_ID_RE);
    expect(body).toMatchObject({ client_name: 'Example assistant', token_endpoint_auth_method: 'none', redirect_uris: [REDIRECT] });
    const stored = await db.query(`SELECT client_name, redirect_uris FROM public.mcp_oauth_clients WHERE client_id = $1`, [body.client_id]);
    expect(stored.rows[0]).toEqual({ client_name: 'Example assistant', redirect_uris: [REDIRECT] });
  });

  it.each([
    ['no callback', { redirect_uris: [] }, 'invalid_redirect_uri'],
    ['an unlisted callback', { redirect_uris: ['https://attacker.example/cb'] }, 'invalid_redirect_uri'],
    ['an unlisted callback beside a listed one', { redirect_uris: [REDIRECT, 'https://attacker.example/cb'] }, 'invalid_redirect_uri'],
    ['an allowlisted callback with a query', { redirect_uris: [`${REDIRECT}?x=1`] }, 'invalid_redirect_uri'],
    ['six callbacks', { redirect_uris: Array(6).fill(REDIRECT) }, 'invalid_redirect_uri'],
    ['a client secret method', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }, 'invalid_client_metadata'],
    ['the implicit grant', { redirect_uris: [REDIRECT], grant_types: ['implicit'] }, 'invalid_client_metadata'],
    ['a token response type', { redirect_uris: [REDIRECT], response_types: ['token'] }, 'invalid_client_metadata'],
  ])('refuses %s, storing nothing', async (_label, body, error) => {
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.mcp_oauth_clients`)).rows[0].n;
    const res = await at('/register', { body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.mcp_oauth_clients`)).rows[0].n).toBe(before);
  });
});

describe('/register with an extra callback, and the refusal log', () => {
  const EXTRA = 'https://assistant.example.com/oauth/callback';

  it('registers a configured extra callback, and parks a request to it', async () => {
    const h = createMcpOauthHandler(liveDeps({ extraRedirectUris: [EXTRA] }));
    const reg = await h(new Request(`${FN}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [EXTRA] }) }));
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: EXTRA, state: 's',
      code_challenge: await pkceChallenge(VERIFIER), code_challenge_method: 'S256', scope: 'mcp:crm', resource: RESOURCE,
    });
    expect((await h(new Request(`${FN}/authorize?${q}`))).status).toBe(302);
    // Without the configuration the same client is refused at /authorize.
    expect((await handler(new Request(`${FN}/authorize?${q}`))).status).toBe(400);
  });

  it('logs the refused callbacks by scheme, host and path, never a query, credentials or the whole name', async () => {
    const lines: string[] = [];
    const h = createMcpOauthHandler(liveDeps({ logSink: (_level, line) => lines.push(line) }));
    const res = await h(new Request(`${FN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT, 'https://user:pw@new.example.com/agents/cb?code=abc123#frag'], client_name: 'New assistant\n' + 'x'.repeat(100) }),
    }));
    expect(res.status).toBe(400);
    const line = lines.find((l) => l.includes('register refused'));
    expect(line).toBeDefined();
    expect(line).toContain('https://new.example.com/agents/cb');
    expect(line).toContain('count=2');
    for (const leak of ['user:pw', 'code=abc123', 'frag', 'x'.repeat(61), 'claude.ai']) expect([leak, line!.includes(leak)]).toEqual([leak, false]);
  });
});

describe('/authorize', () => {
  it('parks the request and sends the browser to the consent screen, issuing nothing', async () => {
    const clientId = await register();
    const res = await park(clientId);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${SITE}/connect`);
    const parked = await db.query(`SELECT client_id, redirect_uri, state, resource FROM public.mcp_oauth_requests WHERE request_id = $1`, [requestIdOf(res)]);
    expect(parked.rows[0]).toEqual({ client_id: clientId, redirect_uri: REDIRECT, state: 'state-1', resource: RESOURCE });
  });

  it.each([
    ['an unknown client', { client_id: 'mcpc_' + 'z'.repeat(43) }],
    ['a malformed client id', { client_id: '<script>' }],
    ['a callback the client did not register', { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }],
    ['a response type other than code', { response_type: 'token' }],
    ['no state', { state: '<absent>' }],
    ['a plain PKCE method', { code_challenge_method: 'plain' }],
    ['no challenge', { code_challenge: '<absent>' }],
    ['another scope', { scope: 'admin' }],
    ['no resource', { resource: '<absent>' }],
    ['another resource', { resource: 'https://elsewhere.example/mcp' }],
  ])('refuses %s with the fixed page, never redirecting', async (_label, over) => {
    const clientId = await register();
    const res = await park(clientId, over);
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    const page = await res.text();
    expect(page).toContain('could not be validated');
    for (const value of Object.values(over)) if (value !== '<absent>') expect(page).not.toContain(value);
  });

  it('re-checks the allowlist at /authorize, for a client registered before it tightened', async () => {
    const clientId = 'mcpc_' + 'l'.repeat(43);
    await db.query(`INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ($1, $2)`, [clientId, ['https://old.example/cb']]);
    const res = await park(clientId, { redirect_uri: 'https://old.example/cb' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('refuses to start a flow when SITE_URL is unset', async () => {
    const res = await createMcpOauthEndpoints(liveDeps({ siteUrl: null })).authorize(new Request(`${FN}/authorize?${AUTHORIZE_QUERY}`));
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
  });
});

describe('the consent calls', () => {
  it('reads the pending request for the owner at aal2', async () => {
    const requestId = requestIdOf(await park(await register('Example assistant')));
    const res = await consent({ action: 'read', request_id: requestId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request_id: requestId, client_name: 'Example assistant', redirect_uri: REDIRECT });
  });

  it('refuses an owner signed in without a second factor, and decides nothing', async () => {
    const requestId = requestIdOf(await park(await register()));
    const res = await consent({ action: 'decide', request_id: requestId, approve: true }, AAL1_OWNER_TOKEN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Approving a connection needs a two-factor sign-in.', code: 'mfa_required' });
    expect((await db.query(`SELECT status, code_hash FROM public.mcp_oauth_requests WHERE request_id = $1`, [requestId])).rows[0]).toEqual({ status: 'pending', code_hash: null });
  });

  it('refuses a client session (403) and no session (401)', async () => {
    const requestId = requestIdOf(await park(await register()));
    expect((await consent({ action: 'read', request_id: requestId }, CLIENT_TOKEN)).status).toBe(403);
    expect((await at('', { headers: { Origin: ALLOWED_ORIGIN }, body: { action: 'read', request_id: requestId } })).status).toBe(401);
  });

  it('refuses a session the database says is not the owner’s', async () => {
    const requestId = requestIdOf(await park(await register()));
    const res = await consent({ action: 'decide', request_id: requestId, approve: true }, NOT_OWNER_TOKEN);
    expect(res.status).toBe(500);
    expect(await consent({ action: 'read', request_id: requestId })).toHaveProperty('status', 200);
  });

  it.each([
    [{ action: 'decide', request_id: 'r' }],
    [{ action: 'decide', request_id: 'r', approve: 'yes' }],
    [{ action: 'delete', request_id: 'r' }],
    [{ action: 'read' }],
    [{ action: 'read', request_id: 'x'.repeat(201) }],
  ])('refuses a malformed call %j with 400', async (body) => {
    expect((await consent(body)).status).toBe(400);
  });

  it('approval answers the callback with a code and the state, once', async () => {
    const requestId = requestIdOf(await park(await register()));
    const res = await consent({ action: 'decide', request_id: requestId, approve: true });
    const to = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('state')).toBe('state-1');
    expect(to.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await consent({ action: 'decide', request_id: requestId, approve: false });
    expect(again.status).toBe(404);
  });

  it('denial answers the callback with access_denied and no code', async () => {
    const requestId = requestIdOf(await park(await register()));
    const to = new URL(((await (await consent({ action: 'decide', request_id: requestId, approve: false })).json()) as { redirect_to: string }).redirect_to);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('code')).toBeNull();
    expect(to.searchParams.get('state')).toBe('state-1');
  });
});

describe('/token', () => {
  it('exchanges an approved code for an access and a refresh token on a live grant', async () => {
    const t = await tokens();
    expect(t.access_token).toMatch(/^mcpat_[A-Za-z0-9_-]{43}$/);
    expect(t.refresh_token).toMatch(/^mcprt_[A-Za-z0-9_-]{43}$/);
    expect((await liveGrant(t.access_token)).g).toMatchObject({ actor: DB_OWNER_ID });
  });

  it('consumes the code first: a wrong verifier burns it, and the right one then fails', async () => {
    const { code, clientId } = await approvedCode();
    const base = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE };
    const wrong = await exchange({ ...base, code_verifier: 'w'.repeat(64) });
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');
    const right = await exchange({ ...base, code_verifier: VERIFIER });
    expect(right.status).toBe(400);
    expect(((await right.json()) as { error_description: string }).error_description).toMatch(/already used/);
  });

  it.each([
    ['another client id', { client_id: 'mcpc_' + 'q'.repeat(43) }, 'client'],
    ['another callback', { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'redirect'],
    ['a wrong verifier', { code_verifier: 'w'.repeat(64) }, 'verifier'],
  ])('refuses a code presented with %s, and audits the rejection as the approver', async (_label, over, reason) => {
    const { code, clientId } = await approvedCode();
    const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, ...over });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    const rows = await db.query(
      `SELECT user_id, details FROM public.audit_logs WHERE action = 'mcp_oauth_code_rejected' AND details ->> 'client_id' = $1`,
      [clientId],
    );
    expect(rows.rows).toEqual([{ user_id: DB_OWNER_ID, details: { source: 'mcp_oauth', client_id: clientId, reason } }]);
  });

  it('a rejected exchange stays refused when its audit row cannot be written', async () => {
    const { code, clientId } = await approvedCode();
    const live = serviceClient(db);
    const noAudit = { ...live, rpc: (fn: string, args?: Record<string, unknown>) =>
      fn === 'mcp_audit_row' ? Promise.resolve({ data: null, error: { message: 'down', code: '08006' } }) : live.rpc(fn, args) };
    const res = await createMcpOauthEndpoints(liveDeps({ db: noAudit })).token(
      new Request(`${FN}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'w'.repeat(64), client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('requires the resource on a code exchange', async () => {
    const { code, clientId } = await approvedCode();
    const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('issues nothing when the approver is no longer the owner', async () => {
    const { code, clientId } = await approvedCode();
    const successor = '00000000-0000-4000-8000-0000000000d1';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'successor@example.test') ON CONFLICT DO NOTHING`, [successor]);
    await db.query(`UPDATE public.org_profile SET owner_user_id = $1`, [successor]);
    try {
      const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    } finally {
      await db.query(`UPDATE public.org_profile SET owner_user_id = $1`, [DB_OWNER_ID]);
    }
  });

  it('a recovery landing between the code\u2019s consumption and the grant issues nothing', async () => {
    const { code, clientId } = await approvedCode();
    const live = serviceClient(db);
    const interleaved = {
      ...live,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'mcp_oauth_create_grant') {
          await db.query(
            `INSERT INTO public.mfa_recovery_lockouts (user_id, revoked_before) VALUES ($1, now() + interval '1 second')
             ON CONFLICT (user_id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before`,
            [DB_OWNER_ID],
          );
        }
        return live.rpc(fn, args);
      },
    };
    try {
      const res = await createMcpOauthEndpoints(liveDeps({ db: interleaved })).token(
        new Request(`${FN}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }) }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
      expect((await db.query(`SELECT 1 FROM public.mcp_oauth_grants WHERE client_id = $1`, [clientId])).rows).toHaveLength(0);
    } finally {
      await db.query(`DELETE FROM public.mfa_recovery_lockouts WHERE user_id = $1`, [DB_OWNER_ID]);
    }
  });

  it('rotates a refresh token (resource optional, a wrong one refused)', async () => {
    const t = await tokens();
    const wrong = await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token, resource: 'https://elsewhere.example' });
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_target');
    const res = await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    const next = (await res.json()) as { access_token: string; refresh_token: string };
    expect(res.status).toBe(200);
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect((await liveGrant(next.access_token)).g).not.toBeNull();
  });

  it('binds a refresh token to its client: another client id is refused and burns nothing', async () => {
    const t = await tokens();
    for (const client_id of ['mcpc_' + 'q'.repeat(43), '']) {
      const res = await exchange({ grant_type: 'refresh_token', client_id, refresh_token: t.refresh_token });
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
    expect((await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token })).status).toBe(200);
  });

  it('allows a refresh that omits client_id, which a connector may do', async () => {
    const t = await tokens();
    const res = await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { access_token: string };
    expect((await liveGrant(next.access_token)).g).not.toBeNull();
  });

  it('a refresh token replayed after the grace revokes the whole connection', async () => {
    const t = await tokens();
    const next = (await (await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token })).json()) as { access_token: string };
    await db.query(`UPDATE public.mcp_oauth_tokens SET rotated_at = now() - interval '1 minute' WHERE token_hash = $1`, [await sha256Hex(t.refresh_token)]);
    const replay = await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    expect(((await replay.json()) as { error_description: string }).error_description).toMatch(/connection was revoked/);
    expect((await liveGrant(next.access_token)).g).toBeNull();
  });

  it('an OAuth error and a token answer are JSON, and the refusal page alone is HTML', async () => {
    const error = await exchange({ grant_type: 'password' });
    expect(error.headers.get('Content-Type')).toBe('application/json');
    const registered = await at('/register', { body: { redirect_uris: ['https://attacker.example/cb'] } });
    expect(registered.headers.get('Content-Type')).toBe('application/json');
    const t = await tokens();
    const ok = await exchange({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    expect(ok.headers.get('Content-Type')).toBe('application/json');
    const page = await at('/authorize?client_id=nope');
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('refuses an unknown grant type and a missing refresh token', async () => {
    expect(((await (await exchange({ grant_type: 'password' })).json()) as { error: string }).error).toBe('unsupported_grant_type');
    expect(((await (await exchange({ grant_type: 'refresh_token' })).json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('/revoke', () => {
  it('answers 200 for an unknown token, and revokes the grant behind a known one', async () => {
    expect((await at('/revoke', { body: new URLSearchParams({ token: 'mcprt_unknown' }) })).status).toBe(200);
    const t = await tokens();
    expect((await at('/revoke', { body: new URLSearchParams({ token: t.refresh_token }) })).status).toBe(200);
    expect((await liveGrant(t.access_token)).g).toBeNull();
  });

  it('never reports a revocation it could not make', async () => {
    const broken = { ...serviceClient(db), rpc: vi.fn(async () => ({ data: null, error: { message: 'down', code: '08006' } })) };
    const res = await createMcpOauthEndpoints(liveDeps({ db: broken })).revoke(
      new Request(`${FN}/revoke`, { method: 'POST', body: new URLSearchParams({ token: 'mcprt_x' }) }),
    );
    expect(res.status).toBe(500);
  });
});
