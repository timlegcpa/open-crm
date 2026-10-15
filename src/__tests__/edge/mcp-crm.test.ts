// @vitest-environment node
// mcp-crm: the JSON-RPC endpoint and the metadata endpoint held to the edge contract, then
// the transport rules and the tools against the real migrations.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, OWNER_ID as DB_OWNER_ID, seedContact, seedCore, SYSTEM_ID } from '../db/harness';
import { ALLOWED_ORIGIN, describeEdgeContract, REFUSED_ORIGIN, throwInternal } from './contract';
import { serviceClient } from './pgliteClient';
import {
  CONNECTOR_ORIGINS,
  createMcpCrmEndpoints,
  createMcpCrmHandler,
  MAX_BATCH,
  MCP_ALLOW_HEADERS,
  PROTOCOL_VERSION,
  type McpCrmDeps,
} from '../../../supabase/functions/mcp-crm/handler';
import { REFUSALS } from '../../../supabase/functions/_shared/handler';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { mcpResourceUrl, protectedResourceMetadataUrl } from '../../../supabase/functions/mcp-oauth/tokens';

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const SITE = 'https://crm.example.com';
const FN = mcpResourceUrl(SUPABASE_URL);
const TOKEN = 'mcpat_' + 't'.repeat(43);
const BEARER = { Authorization: `Bearer ${TOKEN}` };

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

// ---------------------------------------------------------------------------
// The edge contract, with a fake database
// ---------------------------------------------------------------------------

function fakeDb(failing = false): McpCrmDeps['db'] {
  return {
    rpc: async (fn: string) => {
      if (failing) return throwInternal();
      if (fn === 'mcp_oauth_authenticate') return { data: { grant_id: 'g', actor: 'a' }, error: null };
      return { data: null, error: null };
    },
  } as unknown as McpCrmDeps['db'];
}

function contractDeps(over: Partial<McpCrmDeps> = {}): McpCrmDeps {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    supabaseUrl: SUPABASE_URL,
    siteUrl: SITE,
    db: fakeDb(),
    orgName: async () => 'Example Co',
    limit: async () => 'allowed',
    ...over,
  };
}

const ok = createMcpCrmEndpoints(contractDeps());
const limited = createMcpCrmEndpoints(contractDeps({ limit: async () => 'limited' }));

describeEdgeContract({
  name: 'mcp-crm rpc',
  handler: ok.rpc,
  failingHandler: createMcpCrmEndpoints(contractDeps({ db: fakeDb(true) })).rpc,
  limitedHandler: limited.rpc,
  allowHeaders: MCP_ALLOW_HEADERS,
  credentials: BEARER,
  body: { kind: 'bytes', valid: bytes(initialize), maxBytes: 100_000 },
});
describeEdgeContract({
  name: 'mcp-crm metadata',
  method: 'GET',
  handler: ok.metadata,
  failingHandler: createMcpCrmEndpoints(contractDeps({ orgName: throwInternal })).metadata,
  limitedHandler: limited.metadata,
  allowHeaders: MCP_ALLOW_HEADERS,
  credentials: null,
  body: { kind: 'none' },
});

// ---------------------------------------------------------------------------
// Against the real migrations
// ---------------------------------------------------------------------------

let db: PGlite;
let contactId: string;
let handler: (req: Request) => Promise<Response>;

/** A live grant the owner approved, with TOKEN as its access token. */
async function seedGrant(token: string, approvedBy = DB_OWNER_ID): Promise<string> {
  await db.query(
    `INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris) VALUES ('mcpc_${'c'.repeat(43)}', $1) ON CONFLICT DO NOTHING`,
    [['https://claude.ai/api/mcp/auth_callback']],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.mcp_oauth_grants (client_id, scope, approved_by, approved_at, absolute_expires_at)
     VALUES ('mcpc_${'c'.repeat(43)}', 'mcp:crm', $1, now(), now() + interval '30 days') RETURNING id`,
    [approvedBy],
  );
  await db.query(
    `INSERT INTO public.mcp_oauth_tokens (grant_id, token_hash, kind, expires_at) VALUES ($1, $2, 'access', now() + interval '10 minutes')`,
    [rows[0].id, await sha256Hex(token)],
  );
  return rows[0].id;
}

function liveDeps(over: Partial<McpCrmDeps> = {}): McpCrmDeps {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    supabaseUrl: SUPABASE_URL,
    siteUrl: SITE,
    db: serviceClient(db),
    orgName: async () => 'Example Co',
    limit: async () => 'allowed',
    ...over,
  };
}

beforeAll(async () => {
  db = await createDb();
  await seedCore(db);
  contactId = await seedContact(db, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', business_name: 'Acme LLC' });
  await seedGrant(TOKEN);
  handler = createMcpCrmHandler(liveDeps());
}, 60_000);

function post(body: unknown, headers: Record<string, string> = BEARER, h = handler): Promise<Response> {
  return h(new Request(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

const rpc = async (method: string, params: unknown = {}, id: unknown = 1) => (await (await post({ jsonrpc: '2.0', id, method, params })).json()) as {
  id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string };
};
const tool = async (name: string, args: Record<string, unknown>) => {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0].text };
};

describe('authentication', () => {
  it('a missing, malformed or unknown token is a 401 naming the metadata', async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: 'Bearer nope' }, { Authorization: `Bearer mcpat_${'u'.repeat(43)}` }, { Authorization: `Basic ${TOKEN}` }]) {
      const res = await post(initialize, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: REFUSALS.unauthenticated.error, code: REFUSALS.unauthenticated.code });
      expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${protectedResourceMetadataUrl(SUPABASE_URL)}"`);
    }
  });

  it('a malformed token reaches no database lookup', async () => {
    const spy = { rpc: vi.fn(serviceClient(db).rpc) };
    const h = createMcpCrmHandler(liveDeps({ db: spy as unknown as McpCrmDeps['db'] }));
    for (const token of ['nope', `mcpat_${'x'.repeat(42)}`, `mcpat_${'x'.repeat(44)}`, `mcprt_${'x'.repeat(43)}`, `mcpat_${'x'.repeat(42)}!`]) {
      expect((await post(initialize, { Authorization: `Bearer ${token}` }, h)).status).toBe(401);
    }
    expect(spy.rpc).not.toHaveBeenCalled();
  });

  it('a grant whose approver is no longer the owner authenticates nothing', async () => {
    const other = 'mcpat_' + 's'.repeat(43);
    await seedGrant(other, SYSTEM_ID);
    expect((await post(initialize, { Authorization: `Bearer ${other}` })).status).toBe(401);
  });

  it('refuses to serve when SITE_URL is unset', async () => {
    expect((await post(initialize, BEARER, createMcpCrmHandler(liveDeps({ siteUrl: null })))).status).toBe(500);
  });
});

describe('the transport', () => {
  it('allows no Origin and a connector origin; refuses any other, varying on Origin', async () => {
    expect((await post(initialize)).status).toBe(200);
    expect((await post(initialize, { ...BEARER, Origin: CONNECTOR_ORIGINS[0] })).status).toBe(200);
    const res = await post(initialize, { ...BEARER, Origin: REFUSED_ORIGIN });
    expect(res.status).toBe(403);
    expect(res.headers.get('Vary')).toMatch(/Origin/);
  });

  it('answers GET with 405: this server never opens a stream', async () => {
    const res = await handler(new Request(FN, { headers: BEARER }));
    expect(res.status).toBe(405);
  });

  it('initialize answers the protocol version and the server', async () => {
    const res = await rpc('initialize');
    expect(res.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'open-crm' } });
  });

  it('a parse error is -32700 with 400; an empty batch is -32600 with 400', async () => {
    const parse = await post('{nope');
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const empty = await post([]);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('refuses a batch over the cap whole, running none of it', async () => {
    const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({
      jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'log_call_note', arguments: { contact_id: contactId, body: `batch ${i}` } },
    }));
    const res = await post(batch);
    expect(res.status).toBe(413);
    expect((await db.query(`SELECT 1 FROM public.contact_notes WHERE body LIKE 'batch %'`)).rows).toHaveLength(0);
  });

  it('answers a batch in order, an invalid message with -32600 in place', async () => {
    const res = await post([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '1.0', id: 'b', method: 'ping' },
      { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' },
      'not a message',
      { jsonrpc: '2.0', id: 'c', method: 'nope' },
    ]);
    const out = (await res.json()) as Array<{ id: unknown; error?: { code: number } }>;
    expect(out.map((m) => [m.id, m.error?.code ?? 0])).toEqual([['a', 0], ['b', -32600], [null, -32600], [null, -32600], ['c', -32601]]);
  });

  it('runs nothing for a notification, and answers an all-notification batch with 202', async () => {
    const res = await post([{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'log_call_note', arguments: { contact_id: contactId, body: 'from a notification' } } }]);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect((await db.query(`SELECT 1 FROM public.contact_notes WHERE body = 'from a notification'`)).rows).toHaveLength(0);
  });

  it('an unknown tool is -32602; an unknown method -32601', async () => {
    expect((await rpc('tools/call', { name: 'drop_everything', arguments: {} })).error?.code).toBe(-32602);
    expect((await rpc('resources/list')).error?.code).toBe(-32601);
  });

  it('a failing tool is a generic -32603 that leaks nothing', async () => {
    const broken = { rpc: async (fn: string, args?: Record<string, unknown>) =>
      fn === 'mcp_oauth_authenticate' ? serviceClient(db).rpc(fn, args) : { data: null, error: { message: 'secret detail 0451', code: 'XX000' } } };
    const res = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search_contacts', arguments: {} } }, BEARER,
      createMcpCrmHandler(liveDeps({ db: broken as unknown as McpCrmDeps['db'] })));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'Internal error' } });
    expect(text).not.toContain('0451');
  });
});

describe('every JSON reply says it is JSON', () => {
  const type = (res: Response) => res.headers.get('Content-Type');

  it.each([
    ['initialize', initialize],
    ['a tool call', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_contacts', arguments: {} } }],
    ['a refused tool call', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_contacts', arguments: { limit: 1e100 } } }],
    ['a JSON-RPC error', { jsonrpc: '2.0', id: 4, method: 'nope' }],
    ['a batch', [{ jsonrpc: '2.0', id: 5, method: 'ping' }]],
  ])('%s', async (_label, body) => {
    expect(type(await post(body))).toBe('application/json');
  });

  it('a parse error, an empty batch, an oversized batch and a 401', async () => {
    expect(type(await post('{nope'))).toBe('application/json');
    expect(type(await post([]))).toBe('application/json');
    expect(type(await post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }))))).toBe('application/json');
    expect(type(await post(initialize, {}))).toBe('application/json');
  });
});

describe('search_contacts limit', () => {
  it.each([0, 101, 1e100, 2.5, -1, Number.MAX_SAFE_INTEGER])('refuses %s as a tool error, never a server fault', async (limit) => {
    const res = await rpc('tools/call', { name: 'search_contacts', arguments: { limit } });
    expect(res.error).toBeUndefined();
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('limit must be a whole number from 1 to 100.');
  });

  it('accepts 1 and 100', async () => {
    for (const limit of [1, 100]) {
      const res = await rpc('tools/call', { name: 'search_contacts', arguments: { limit } });
      expect((res.result as { isError?: boolean }).isError).toBeUndefined();
    }
  });
});

describe('the protected-resource metadata', () => {
  it('names this resource and the site as its authorization server', async () => {
    const res = await handler(new Request(`${FN}/.well-known/oauth-protected-resource`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: FN, authorization_servers: [SITE], scopes_supported: ['mcp:crm'], bearer_methods_supported: ['header'], resource_name: 'Example Co',
    });
  });

  it('answers 404 for any other path', async () => {
    for (const path of ['/nope', '/constructor', '/.well-known/other']) {
      expect([path, (await handler(new Request(`${FN}${path}`))).status]).toEqual([path, 404]);
    }
  });
});

describe('the tools', () => {
  it('tools/list fills the pick lists from the database; delete_quote takes any service', async () => {
    const tools = (await rpc('tools/list')).result!.tools as Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }>;
    const prop = (name: string, p: string) => tools.find((t) => t.name === name)!.inputSchema.properties[p];
    const statuses = (await db.query<{ key: string }>(`SELECT key FROM public.contact_statuses ORDER BY sort_order`)).rows.map((r) => r.key);
    expect(prop('search_contacts', 'status').enum).toEqual(statuses);
    expect(prop('upsert_quote', 'service_type').enum!.length).toBeGreaterThan(0);
    expect(prop('add_business', 'organization_type').enum!.length).toBeGreaterThan(0);
    expect(prop('delete_quote', 'service_type').enum).toBeUndefined();
    expect(tools.map((t) => t.name)).not.toContain('send_request');
  });

  it('search and get return the contact, audited as the owner who approved', async () => {
    const found = await tool('search_contacts', { query: 'lovelace' });
    expect(JSON.parse(found.text).contacts.map((c: { id: string }) => c.id)).toEqual([contactId]);
    const got = await tool('get_contact', { contact_id: contactId });
    expect(JSON.parse(got.text)).toMatchObject({ id: contactId, email: 'ada@example.com' });
    const audit = await db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM public.audit_logs WHERE action IN ('mcp_search_contacts', 'mcp_get_contact')`);
    expect(audit.rows).toEqual([{ user_id: DB_OWNER_ID }]);
  });

  it('create refuses a duplicate address as a tool error naming the existing id', async () => {
    const dup = await tool('create_contact', { email: ' ADA@example.com ' });
    expect(dup).toEqual({ isError: true, text: `A contact with that email already exists (id ${contactId}).` });
  });

  it('update refuses an email field outright, changing nothing', async () => {
    const res = await tool('update_contact', { contact_id: contactId, phone: '555-0100', email: 'x@example.com' });
    expect(res.isError).toBe(true);
    expect((await db.query(`SELECT phone FROM public.contacts WHERE id = $1`, [contactId])).rows[0]).toEqual({ phone: null });
  });

  it('delete_quote refuses without confirmed_with_user, deleting nothing', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.contact_services (contact_id, service_type, state, cadence, amount) VALUES ($1, 'project', 'proposed', 'monthly', 100) RETURNING id`,
      [contactId],
    );
    const res = await tool('delete_quote', { contact_id: contactId, quote_id: rows[0].id, service_type: 'project' });
    expect(res.isError).toBe(true);
    expect((await db.query(`SELECT 1 FROM public.contact_services WHERE id = $1`, [rows[0].id])).rows).toHaveLength(1);
    const done = await tool('delete_quote', { contact_id: contactId, quote_id: rows[0].id, service_type: 'project', confirmed_with_user: true });
    expect(done.isError).toBe(false);
    expect((await db.query(`SELECT 1 FROM public.contact_services WHERE id = $1`, [rows[0].id])).rows).toHaveLength(0);
  });

  it('a note logged through the connector carries source mcp', async () => {
    const res = await tool('log_call_note', { contact_id: contactId, body: 'Talked through the scope' });
    expect(res.isError).toBe(false);
    expect((await db.query(`SELECT source, kind FROM public.contact_notes WHERE body = 'Talked through the scope'`)).rows).toEqual([{ source: 'mcp', kind: 'call' }]);
  });
});
