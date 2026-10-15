// @vitest-environment node
// mcp-crm: the JSON-RPC endpoint and the metadata endpoint held to the edge contract, then
// the transport rules and the tools against the real migrations.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { SendResult } from '../../../supabase/functions/_shared/outbound';
import { mcpResourceUrl, protectedResourceMetadataUrl } from '../../../supabase/functions/mcp-oauth/tokens';
import { createRequestOutward, type RequestOutward } from '../../../supabase/functions/mcp-crm/outward';
import { createReviewSigner } from '../../../supabase/functions/mcp-crm/review-token';
import type { NeedsSendStore } from '../../../supabase/functions/send-needs-list/handler';

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const SITE = 'https://crm.example.com';
const FN = mcpResourceUrl(SUPABASE_URL);
const TOKEN = 'mcpat_' + 't'.repeat(43);
const BEARER = { Authorization: `Bearer ${TOKEN}` };

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
const REVIEW = createReviewSigner('test-review-secret-0123456789abcdef');
const OWNER_EMAIL = 'owner@example.com';
/** For the contract runs: no tool there reaches the outward arm. */
const noOutward: RequestOutward = {
  send: async () => { throw new Error('unexpected send'); },
  remind: async () => { throw new Error('unexpected remind'); },
  receipt: async () => 'failed',
  alert: async () => false,
};
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
    review: REVIEW,
    outward: noOutward,
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

interface Mail {
  to: string;
  subject: string;
  text: string;
  key: string;
}

/** Every message the outward arm sent, and the mail result the next ones get. */
const mail: { sent: Mail[]; result: () => SendResult } = { sent: [], result: () => ({ status: 'sent', channel: 'local', id: null }) };

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

let tokenSeq = 0;

/** send-needs-list's store over PGlite as the server, mail recorded: what index.ts builds over supabase-js. */
function pgliteStore(): NeedsSendStore {
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
    loadOrg: async () => ({ displayName: 'Example Co', legalName: null, senderName: 'Example Co', postalAddress: null, logoUrl: null, brandColor: null }),
    async sendEmail({ to, subject, content, idempotencyKey }) {
      const text = content.blocks.map((b) => ('text' in b ? b.text : 'url' in b ? `${b.label} ${b.url}` : b.items.join(' | '))).join('\n');
      mail.sent.push({ to, subject, text, key: idempotencyKey });
      return mail.result();
    },
    newToken: () => String(++tokenSeq).padStart(43, 'T'),
  };
}

function liveDeps(over: Partial<McpCrmDeps> = {}, store: NeedsSendStore = pgliteStore()): McpCrmDeps {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    supabaseUrl: SUPABASE_URL,
    siteUrl: SITE,
    db: serviceClient(db),
    orgName: async () => 'Example Co',
    limit: async () => 'allowed',
    review: REVIEW,
    outward: createRequestOutward({ store, siteUrl: SITE, ownerEmail: async () => OWNER_EMAIL }),
    sleep: async () => {},
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
    const categories = (await db.query<{ key: string }>(`SELECT key FROM public.request_categories WHERE is_active ORDER BY sort_order, key`)).rows.map((r) => r.key);
    const tags = (await db.query<{ key: string }>(`SELECT key FROM public.request_tags WHERE is_active ORDER BY sort_order, key`)).rows.map((r) => r.key);
    const item = (tool: string) => (prop(tool, 'items') as unknown as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
    for (const tool of ['create_request', 'update_request']) {
      expect(item(tool).category.enum).toEqual(categories);
      expect(item(tool).tag.enum).toEqual(tags);
    }
    expect(tools.map((t) => t.name)).toEqual([
      'search_contacts', 'get_contact', 'create_contact', 'update_contact', 'correct_contact_email', 'add_business', 'log_call_note',
      'upsert_quote', 'delete_quote', 'create_request', 'update_request', 'list_requests', 'send_request', 'remind_request', 'delete_request',
    ]);
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

// ---------------------------------------------------------------------------
// The request tools, end to end: the tools, the real migrations, send-needs-list's own
// send and reminder, and only the mail recorded
// ---------------------------------------------------------------------------

describe('the request tools', () => {
  const ITEMS = [
    { label: 'Signed contract', category: 'contract' },
    { label: 'Account number', kind: 'question', sensitive: true },
    { label: 'Book a call', kind: 'todo', required: false },
  ];
  let seq = 0;

  interface ToolOut { isError: boolean; text: string; json: () => Record<string, any> }
  async function callOn(h: (req: Request) => Promise<Response>, name: string, args: Record<string, unknown>): Promise<ToolOut> {
    const res = (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, BEARER, h)).json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const text = res.result.content[0].text;
    return { isError: res.result.isError === true, text, json: () => JSON.parse(text) };
  }
  const on = (name: string, args: Record<string, unknown>) => callOn(handler, name, args);

  async function contact(): Promise<{ id: string; email: string }> {
    seq += 1;
    const email = `grace-${seq}@example.com`;
    return { id: await seedContact(db, { first_name: 'Grace', last_name: 'Hopper', email }), email };
  }
  async function draft(contactId: string, title = 'Project documents'): Promise<string> {
    const out = await on('create_request', { contact_id: contactId, title, intro_message: 'Thanks!', items: ITEMS });
    expect(out.isError, out.text).toBe(false);
    return out.json().created.id;
  }
  async function tokenOf(contactId: string, listId: string): Promise<string> {
    const listed = (await on('list_requests', { contact_id: contactId })).json();
    return listed.requests.find((r: { list_id: string }) => r.list_id === listId).review_token;
  }
  const status = async (listId: string) => (await q<{ status: string }>(`SELECT status FROM public.needs_lists WHERE id = $1`, [listId]))[0]?.status;
  const audits = (listId: string, action: string) =>
    q<{ user_id: string; details: Record<string, unknown> }>(
      `SELECT user_id, details FROM public.audit_logs WHERE action = $1 AND details ->> 'list_id' = $2 ORDER BY created_at, id`, [action, listId]);
  const go = (listId: string, contactId: string, token: string) => ({ list_id: listId, contact_id: contactId, review_token: token, confirmed_with_user: true });
  /** Each row's outcome, with its reason when refused: the list's whole trail for one action. */
  const trail = async (listId: string, action: string) =>
    (await audits(listId, action)).map((r) => (r.details.outcome === 'refused' ? `refused:${String(r.details.reason)}` : String(r.details.outcome)));
  const lastReminded = async (listId: string) =>
    (await q<{ at: string | null }>(`SELECT last_reminded_at::text AS at FROM public.needs_lists WHERE id = $1`, [listId]))[0].at;
  /** The live database with one function intercepted. */
  const intercept = (fn: string, answer: (args?: Record<string, unknown>) => Promise<unknown>) => {
    const live = serviceClient(db);
    return {
      rpc: (name: string, args?: Record<string, unknown>) => (name === fn ? answer(args) : live.rpc(name, args)),
    } as unknown as McpCrmDeps['db'];
  };
  /** A sent request whose token was read after the send. */
  async function sentRequest(): Promise<{ c: { id: string; email: string }; listId: string; token: string }> {
    const c = await contact();
    const listId = await draft(c.id);
    await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    mail.sent = [];
    return { c, listId, token: await tokenOf(c.id, listId) };
  }

  beforeEach(() => {
    mail.sent = [];
    mail.result = () => ({ status: 'sent', channel: 'local', id: null });
  });

  it('create, read back, send: the contact gets one email, the owner a copy, recorded as the owner', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    expect(await status(listId)).toBe('draft');
    const listed = (await on('list_requests', { contact_id: c.id })).json();
    expect(listed.contact).toEqual({ contact_id: c.id, name: 'Grace Hopper', email: c.email });
    expect(listed.requests[0]).toMatchObject({
      list_id: listId, status: 'draft', title: 'Project documents', intro_message: 'Thanks!', item_count: 3,
      items: [
        { label: 'Signed contract', kind: 'document', required: true, sensitive: false, category: 'contract', answered: false },
        { label: 'Account number', kind: 'question', sensitive: true, answered: false },
        { label: 'Book a call', kind: 'todo', required: false, answered: false },
      ],
    });
    const token = listed.requests[0].review_token as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const unconfirmed = await on('send_request', { ...go(listId, c.id, token), confirmed_with_user: undefined });
    expect(unconfirmed.isError).toBe(true);
    expect(mail.sent).toEqual([]);

    const sent = await on('send_request', go(listId, c.id, token));
    expect(sent.json()).toMatchObject({ sent: { list_id: listId, title: 'Project documents' }, email_sent: true, receipt_to_owner_sent: true });
    expect(await status(listId)).toBe('sent');
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      [c.email, 'New request: Project documents'],
      [OWNER_EMAIL, 'Sent by your AI assistant: Project documents'],
    ]);
    expect(mail.sent[1].text).toContain('Signed contract (document)');
    expect(mail.sent[1].text).toContain(`${SITE}/contacts/${c.id}/requests`);
    expect(await audits(listId, 'mcp_send_request')).toEqual([
      { user_id: DB_OWNER_ID, details: { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'refused', reason: 'unconfirmed' } },
      { user_id: DB_OWNER_ID, details: { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'attempt', content_version: expect.any(Number) } },
      { user_id: DB_OWNER_ID, details: { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'sent', email_status: 'sent', receipt_status: 'sent' } },
    ]);
    // The start link the send minted names the owner who approved the connection.
    expect(await q(`SELECT created_by FROM public.pending_signup_requests WHERE needs_list_id = $1`, [listId])).toEqual([{ created_by: DB_OWNER_ID }]);
  });

  it('never returns an answer, gives tokens only to a draft or a sent request, and says when the list is cut short', async () => {
    const c = await contact();
    for (let i = 0; i < 24; i++) {
      await q(`INSERT INTO public.needs_lists (contact_id, title, created_at) VALUES ($1, $2, now() - make_interval(days => $3))`, [c.id, `Old ${i}`, i + 2]);
    }
    const [sent] = await q<{ id: string }>(`INSERT INTO public.needs_lists (contact_id, title, status, sent_at) VALUES ($1, 'Sent one', 'sent', now()) RETURNING id`, [c.id]);
    await q(`INSERT INTO public.needs_items (list_id, kind, label, answer_text, status) VALUES ($1, 'question', 'Favourite colour', 'secret-answer-0451', 'fulfilled')`, [sent.id]);
    const [closed] = await q<{ id: string }>(`INSERT INTO public.needs_lists (contact_id, title, status, created_at) VALUES ($1, 'Closed one', 'closed', now() - interval '1 day') RETURNING id`, [c.id]);
    const out = await on('list_requests', { contact_id: c.id });
    expect(out.text).not.toContain('secret-answer-0451');
    const listed = out.json();
    expect([listed.count, listed.truncated]).toEqual([25, true]);
    expect(listed.truncation_note).toMatch(/Do not tell your user this is all of them/);
    const byId = (id: string) => listed.requests.find((r: { list_id: string }) => r.list_id === id);
    expect(byId(sent.id)).toMatchObject({ status: 'sent', items: [{ label: 'Favourite colour', answered: true }] });
    expect(byId(sent.id).review_token).toMatch(/^[0-9a-f]{32}$/);
    expect(byId(closed.id)).not.toHaveProperty('review_token');
    expect(listed.requests.filter((r: { status: string }) => r.status === 'draft').every((r: { review_token?: string }) => r.review_token)).toBe(true);
    expect(await q(`SELECT details FROM public.audit_logs WHERE action = 'mcp_list_requests' AND details ->> 'contact_id' = $1`, [c.id]))
      .toEqual([{ details: { source: 'mcp', contact_id: c.id, returned: 25, truncated: true } }]);
  });

  it('a token goes stale when the draft or the recipient changes, and nothing is sent', async () => {
    const c = await contact();
    const edited = await draft(c.id, 'Edited');
    const t1 = await tokenOf(c.id, edited);
    const updated = await on('update_request', { list_id: edited, contact_id: c.id, review_token: t1, title: 'Edited', items: [ITEMS[0]] });
    expect(updated.json().updated).toEqual({ list_id: edited, title: 'Edited', item_count: 1 });
    const r1 = await on('send_request', go(edited, c.id, t1));
    expect([r1.isError, r1.text]).toEqual([true, expect.stringMatching(/does not match the request as it stands now/)]);
    expect(await trail(edited, 'mcp_send_request')).toEqual(['refused:stale_token']);

    const moved = await draft(c.id, 'Moved');
    const t2 = await tokenOf(c.id, moved);
    await q(`UPDATE public.contacts SET email = $2 WHERE id = $1`, [c.id, `moved-${seq}@example.com`]);
    const r2 = await on('send_request', go(moved, c.id, t2));
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/does not match/);

    expect(mail.sent).toEqual([]);
    expect([await status(edited), await status(moved)]).toEqual(['draft', 'draft']);
  });

  it('sends a draft only: a sent request is never sent again, even with its current token', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    mail.sent = [];
    const again = await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect([again.isError, again.text]).toEqual([true, 'That request is sent, not a draft, so it cannot be sent again.']);
    expect(mail.sent).toEqual([]);
  });

  it('binds the named contact: another contact’s id finds no request', async () => {
    const c = await contact();
    const other = await contact();
    const listId = await draft(c.id);
    const token = await tokenOf(c.id, listId);
    for (const name of ['send_request', 'delete_request']) {
      const out = await on(name, go(listId, other.id, token));
      expect([name, out.text]).toEqual([name, 'No request with that id for that contact. Read the requests again with list_requests.']);
    }
    expect(await status(listId)).toBe('draft');
  });

  it('sends one client email per HTTP request: the second send in a batch is refused and sends nothing', async () => {
    const c = await contact();
    const a = await draft(c.id, 'First');
    const b = await draft(c.id, 'Second');
    const [ta, tb] = [await tokenOf(c.id, a), await tokenOf(c.id, b)];
    const res = await post([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_request', arguments: go(a, c.id, ta) } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remind_request', arguments: go(b, c.id, tb) } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_request', arguments: go(b, c.id, tb) } },
    ]);
    const out = (await res.json()) as Array<{ result: { isError?: boolean; content: Array<{ text: string }> } }>;
    expect(out.map((m) => m.result.isError === true)).toEqual([false, true, true]);
    for (const m of out.slice(1)) expect(m.result.content[0].text).toMatch(/^Only one email to a contact can go out per call/);
    expect(mail.sent.filter((m) => m.to === c.email)).toHaveLength(1);
    expect([await status(a), await status(b)]).toEqual(['sent', 'draft']);
    expect([await trail(b, 'mcp_remind_request'), await trail(b, 'mcp_send_request')]).toEqual([['refused:budget'], ['refused:budget']]);
  });

  it('an edit or an address change landing after the token check publishes nothing', async () => {
    for (const [label, late] of [
      ['an edit', (listId: string) => q(`INSERT INTO public.needs_items (list_id, kind, label) VALUES ($1, 'todo', 'Late edit')`, [listId])],
      ['an address change', async (listId: string) => {
        await q(`UPDATE public.contacts SET email = 'late@example.com' WHERE id = (SELECT contact_id FROM public.needs_lists WHERE id = $1)`, [listId]);
      }],
    ] as const) {
      const c = await contact();
      const listId = await draft(c.id);
      const token = await tokenOf(c.id, listId);
      const store = pgliteStore();
      const load = store.loadList;
      store.loadList = async (id) => {
        const row = await load(id);
        await late(id);
        return row;
      };
      const out = await callOn(createMcpCrmHandler(liveDeps({}, store)), 'send_request', go(listId, c.id, token));
      expect([label, out.isError, out.text]).toEqual([label, true, expect.stringMatching(/changed since you read it\. .*Nothing was sent\./)]);
      expect(await status(listId)).toBe('draft');
      expect(mail.sent).toEqual([]);
      expect(await trail(listId, 'mcp_send_request')).toEqual(['attempt', 'changed']);
      // A start link minted for a send that published nothing is retired, never left live.
      expect((await q<{ status: string }>(`SELECT status FROM public.pending_signup_requests WHERE needs_list_id = $1`, [listId])).map((r) => r.status))
        .not.toContain('pending');
    }
  });

  it('reminds a sent request once a day, with the owner’s copy; never a draft', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const early = await on('remind_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(early.text).toMatch(/still a draft/);
    await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    mail.sent = [];
    const token = await tokenOf(c.id, listId);
    const reminded = await on('remind_request', go(listId, c.id, token));
    expect(reminded.json()).toMatchObject({ reminded: { list_id: listId, items_open: 3 }, email_sent: true, receipt_to_owner_sent: true });
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      [c.email, 'Reminder: Project documents'],
      [OWNER_EMAIL, 'Reminder sent by your AI assistant: Project documents'],
    ]);
    const again = await on('remind_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(again.text).toMatch(/less than a day ago/);
    expect(mail.sent).toHaveLength(2);
    expect((await audits(listId, 'mcp_remind_request')).map((r) => r.details)).toEqual([
      { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'refused', reason: 'not_sent' },
      { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'attempt', content_version: expect.any(Number) },
      { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'reminded', email_status: 'sent', remaining: 3, receipt_status: 'sent' },
      { source: 'mcp', contact_id: c.id, list_id: listId, outcome: 'refused', reason: 'reminder_claimed' },
    ]);
  });

  it('a token minted before an answer is stale for a reminder: the count it claims changed', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    const token = await tokenOf(c.id, listId);
    await q(`UPDATE public.needs_items SET status = 'fulfilled' WHERE list_id = $1 AND kind = 'todo'`, [listId]);
    mail.sent = [];
    const out = await on('remind_request', go(listId, c.id, token));
    expect(out.text).toMatch(/does not match/);
    expect(mail.sent).toEqual([]);
    expect(await trail(listId, 'mcp_remind_request')).toEqual(['refused:stale_token']);
  });

  it('deletes a draft read back with its token; never a sent one or one changed since', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const deleted = await on('delete_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(deleted.json()).toMatchObject({ deleted: { list_id: listId, title: 'Project documents', item_count: 3 } });
    expect(await status(listId)).toBeUndefined();
    expect((await audits(listId, 'mcp_delete_request'))).toHaveLength(1);

    const stale = await draft(c.id);
    const t = await tokenOf(c.id, stale);
    expect((await on('update_request', { list_id: stale, contact_id: c.id, review_token: t, title: 'Changed', items: ITEMS })).isError).toBe(false);
    expect((await on('delete_request', go(stale, c.id, t))).text).toMatch(/does not match/);
    expect(await status(stale)).toBe('draft');

    const sent = await draft(c.id);
    await on('send_request', go(sent, c.id, await tokenOf(c.id, sent)));
    expect((await on('delete_request', go(sent, c.id, await tokenOf(c.id, sent)))).text).toMatch(/not a draft/);
    expect(await status(sent)).toBe('sent');
    expect([await trail(stale, 'mcp_delete_request'), await trail(sent, 'mcp_delete_request')]).toEqual([['refused:stale_token'], ['refused:not_draft']]);
  });

  it('reports a failed client email and a missing owner copy as they happened', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    mail.result = () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 });
    const out = await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(out.json()).toMatchObject({ email_sent: false, receipt_to_owner_sent: false, note: expect.stringMatching(/DID NOT go out/) });
    expect(out.json().receipt_warning).toMatch(/did not go out/);
    expect(await status(listId)).toBe('sent');

    const noOwner = createMcpCrmHandler(liveDeps({
      outward: createRequestOutward({ store: pgliteStore(), siteUrl: SITE, ownerEmail: async () => null }),
    }));
    mail.result = () => ({ status: 'unknown', channel: 'resend' });
    const other = await draft(c.id);
    const unknown = await callOn(noOwner, 'send_request', go(other, c.id, await tokenOf(c.id, other)));
    expect(unknown.json()).toMatchObject({ email_sent: 'unknown', receipt_to_owner_sent: false });
  });

  it('a send that fails partway says the outcome is unknown, never that nothing was sent', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const store = pgliteStore();
    store.sendList = async () => {
      throw new Error('connection lost');
    };
    const out = await callOn(createMcpCrmHandler(liveDeps({}, store)), 'send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/whether the request was published is unknown/);
    expect(out.text).not.toMatch(/Nothing was sent/);
    expect(await trail(listId, 'mcp_send_request')).toEqual(['attempt', 'unknown']);
  });

  it('an outward act whose audit row cannot be written emails the owner the record, after three attempts', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const token = await tokenOf(c.id, listId);
    let attempts = 0;
    const live = serviceClient(db);
    const flaky = {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        // The attempt row goes in; every write after it fails.
        if (fn === 'mcp_audit_row' && ++attempts > 1) return Promise.resolve({ data: null, error: { message: 'audit down', code: 'XX000' } });
        return live.rpc(fn, args);
      },
    };
    const out = await callOn(createMcpCrmHandler(liveDeps({ db: flaky as unknown as McpCrmDeps['db'] })), 'send_request', go(listId, c.id, token));
    expect(out.json()).toMatchObject({ email_sent: true, warning: expect.stringMatching(/The owner has been emailed/) });
    expect(attempts).toBe(4);
    expect(await trail(listId, 'mcp_send_request')).toEqual(['attempt']);
    const alert = mail.sent.find((m) => m.subject === 'Audit record missing: mcp_send_request');
    expect(alert?.to).toBe(OWNER_EMAIL);
    expect(alert?.text).toContain(`list_id: ${listId}`);
    expect(alert?.text).not.toContain(c.email);
  });

  it('an outward act whose attempt row cannot be written sends nothing, and a reminder hands its claim back', async () => {
    const down = intercept('mcp_audit_row', async () => ({ data: null, error: { message: 'audit down', code: 'XX000' } }));
    const c = await contact();
    const listId = await draft(c.id);
    const send = await callOn(createMcpCrmHandler(liveDeps({ db: down })), 'send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect([send.isError, send.text]).toEqual([true, expect.stringMatching(/^Nothing was sent: the audit trail could not be written/)]);
    expect([await status(listId), mail.sent]).toEqual(['draft', []]);

    const r = await sentRequest();
    const remind = await callOn(createMcpCrmHandler(liveDeps({ db: down })), 'remind_request', go(r.listId, r.c.id, r.token));
    expect(remind.text).toMatch(/^Nothing was sent: the audit trail could not be written/);
    expect([mail.sent, await lastReminded(r.listId)]).toEqual([[], null]);
  });

  it('a reminder that does not go out hands its claim back, to NULL or to the earlier reminder', async () => {
    const EARLIER = '2026-01-02 03:04:05.123456+00';
    const cases: Array<[string, (store: NeedsSendStore, listId: string) => void]> = [
      ['the address changed', (store, listId) => {
        const load = store.loadList;
        store.loadList = async (id) => {
          const row = await load(id);
          await q(`UPDATE public.contacts SET email = 'late@example.com' WHERE id = (SELECT contact_id FROM public.needs_lists WHERE id = $1)`, [listId]);
          return row;
        };
      }],
      ['the content changed', (store, listId) => {
        const load = store.loadList;
        store.loadList = async (id) => {
          await q(`UPDATE public.needs_lists SET title = 'Late edit' WHERE id = $1`, [listId]);
          return load(id);
        };
      }],
      ['the mail provider refused', () => {
        mail.result = () => ({ status: 'failed', channel: 'resend', reason: 'rejected', httpStatus: 422 });
      }],
      ['it threw partway', (store) => {
        store.progress = async () => {
          throw new Error('connection lost');
        };
      }],
    ];
    for (const [label, breakIt] of cases) {
      for (const prior of [null, EARLIER]) {
        mail.result = () => ({ status: 'sent', channel: 'local', id: null });
        const r = await sentRequest();
        if (prior) await q(`UPDATE public.needs_lists SET last_reminded_at = $2 WHERE id = $1`, [r.listId, prior]);
        const token = prior ? await tokenOf(r.c.id, r.listId) : r.token;
        const store = pgliteStore();
        breakIt(store, r.listId);
        const out = await callOn(createMcpCrmHandler(liveDeps({}, store)), 'remind_request', go(r.listId, r.c.id, token));
        expect([label, out.isError]).toEqual([label, true]);
        // A refused provider call is recorded as a message; every other case reaches no mail at all.
        if (label !== 'the mail provider refused') expect([label, mail.sent]).toEqual([label, []]);
        const restored = (await q<{ ok: boolean | null }>(
          `SELECT last_reminded_at IS NOT DISTINCT FROM $2::timestamptz AS ok FROM public.needs_lists WHERE id = $1`, [r.listId, prior]))[0].ok;
        expect([label, prior, restored]).toEqual([label, prior, true]);
      }
    }
    mail.result = () => ({ status: 'sent', channel: 'local', id: null });
  });

  it('a reminder refuses an edit landing after the token check: nothing sent, recorded as changed', async () => {
    const r = await sentRequest();
    const store = pgliteStore();
    const load = store.loadList;
    store.loadList = async (id) => {
      await q(`UPDATE public.needs_lists SET title = 'Late edit' WHERE id = $1`, [r.listId]);
      return load(id);
    };
    const out = await callOn(createMcpCrmHandler(liveDeps({}, store)), 'remind_request', go(r.listId, r.c.id, r.token));
    expect([out.isError, out.text]).toEqual([true, expect.stringMatching(/^The request or its recipient changed since you read it\. Nothing was sent\./)]);
    expect(mail.sent).toEqual([]);
    expect(await trail(r.listId, 'mcp_remind_request')).toEqual(['attempt', 'changed']);
  });

  it('a reminder whose claim errors or is refused sends nothing and is recorded with its reason', async () => {
    const r = await sentRequest();
    const failing = intercept('mcp_claim_reminder', async () => ({ data: null, error: { message: 'claim down', code: 'XX000' } }));
    const out = await callOn(createMcpCrmHandler(liveDeps({ db: failing })), 'remind_request', go(r.listId, r.c.id, r.token));
    expect([out.isError, out.text]).toEqual([true, expect.stringMatching(/could not be scheduled, so nothing was sent/)]);
    await q(`UPDATE public.needs_lists SET last_reminded_at = now() WHERE id = $1`, [r.listId]);
    const held = await on('remind_request', go(r.listId, r.c.id, await tokenOf(r.c.id, r.listId)));
    expect(held.text).toMatch(/less than a day ago/);
    expect(mail.sent).toEqual([]);
    expect(await trail(r.listId, 'mcp_remind_request')).toEqual(['refused:claim_error', 'refused:reminder_claimed']);
  });

  it('records every refusal by reason code with ids only, never the caller’s text', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const token = await tokenOf(c.id, listId);
    for (const name of ['send_request', 'delete_request', 'remind_request']) {
      await on(name, { ...go(listId, c.id, token), confirmed_with_user: 'yes' });
      await on(name, { ...go(listId, c.id, token), review_token: 'not a token at all' });
      await on(name, { ...go(listId, c.id, token), contact_id: 'Ada Lovelace <ada@example.com>' });
    }
    const rows = await q<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM public.audit_logs WHERE details ->> 'list_id' = $1 AND details ->> 'outcome' = 'refused' ORDER BY created_at, id`, [listId]);
    const ids = { source: 'mcp', list_id: listId };
    expect(rows).toEqual(['mcp_send_request', 'mcp_delete_request', 'mcp_remind_request'].flatMap((action) => [
      { action, details: { ...ids, contact_id: c.id, outcome: 'refused', reason: 'unconfirmed' } },
      { action, details: { ...ids, contact_id: c.id, outcome: 'refused', reason: 'invalid_token' } },
      { action, details: { ...ids, outcome: 'refused', reason: 'invalid_id' } },
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/not a token|Lovelace|example\.com/);
    expect(await status(listId)).toBe('draft');
  });

  it('update_request rewrites only the draft that was read: it needs the token, and an edit since refuses', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const bare = await on('update_request', { list_id: listId, contact_id: c.id, title: 'No token', items: ITEMS });
    expect([bare.isError, bare.text]).toEqual([true, 'review_token is required. Get it from list_requests.']);

    const token = await tokenOf(c.id, listId);
    await q(`UPDATE public.needs_lists SET title = 'Owner edit' WHERE id = $1`, [listId]);
    const stale = await on('update_request', { list_id: listId, contact_id: c.id, review_token: token, title: 'Assistant', items: ITEMS });
    expect(stale.text).toMatch(/does not match the request as it stands now/);

    // The owner's edit lands after the token check, before the rewrite commits.
    const fresh = await tokenOf(c.id, listId);
    const racing = intercept('mcp_update_request', async (args) => {
      await q(`UPDATE public.needs_lists SET title = 'Owner again' WHERE id = $1`, [listId]);
      return serviceClient(db).rpc('mcp_update_request', args);
    });
    const raced = await callOn(createMcpCrmHandler(liveDeps({ db: racing })), 'update_request', { list_id: listId, contact_id: c.id, review_token: fresh, title: 'Assistant', items: ITEMS });
    expect([raced.isError, raced.text]).toEqual([true, expect.stringMatching(/^The draft changed since you read it/)]);
    expect((await q<{ title: string }>(`SELECT title FROM public.needs_lists WHERE id = $1`, [listId]))[0].title).toBe('Owner again');
    expect(await audits(listId, 'mcp_update_request')).toEqual([]);

    const ok = await on('update_request', { list_id: listId, contact_id: c.id, review_token: await tokenOf(c.id, listId), title: 'Assistant', items: [ITEMS[0]] });
    expect(ok.json().updated).toEqual({ list_id: listId, title: 'Assistant', item_count: 1 });
  });

  it('a reminder refuses an answer landing after the token check: nothing sent, the claim handed back', async () => {
    const r = await sentRequest();
    // The contact answers while the claim is being taken, after the tool verified the token.
    const answering = intercept('mcp_claim_reminder', async (args) => {
      await q(`UPDATE public.needs_items SET status = 'fulfilled' WHERE list_id = $1 AND kind = 'todo'`, [r.listId]);
      return serviceClient(db).rpc('mcp_claim_reminder', args);
    });
    const out = await callOn(createMcpCrmHandler(liveDeps({ db: answering })), 'remind_request', go(r.listId, r.c.id, r.token));
    expect([out.isError, out.text]).toEqual([true, expect.stringMatching(/^The request or its recipient changed since you read it\. Nothing was sent\./)]);
    expect(mail.sent).toEqual([]);
    expect(await lastReminded(r.listId)).toBeNull();
    expect(await trail(r.listId, 'mcp_remind_request')).toEqual(['attempt', 'changed']);
    // The same reminder, read again, goes out.
    const again = await on('remind_request', go(r.listId, r.c.id, await tokenOf(r.c.id, r.listId)));
    expect(again.json()).toMatchObject({ reminded: { items_open: 2 }, email_sent: true });
  });

  it('a publish refusal this arm does not know is reported as changed, with nothing sent', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const store = pgliteStore();
    store.sendList = async () => 'address_changed' as never;
    const out = await callOn(createMcpCrmHandler(liveDeps({}, store)), 'send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect([out.isError, out.text]).toEqual([true, expect.stringMatching(/changed since you read it\. .*Nothing was sent\./)]);
    expect([await status(listId), mail.sent]).toEqual(['draft', []]);
    expect(await trail(listId, 'mcp_send_request')).toEqual(['attempt', 'changed']);
  });

  it('an owner copy whose answer was lost is reported as unknown, never as not sent', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    mail.result = () => (mail.sent[mail.sent.length - 1].to === OWNER_EMAIL ? { status: 'unknown', channel: 'resend' } : { status: 'sent', channel: 'local', id: null });
    const out = await on('send_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(out.json()).toMatchObject({ email_sent: true, receipt_to_owner_sent: 'unknown', receipt_warning: expect.stringMatching(/^Whether the owner's copy of this email went out is unknown/) });
    expect((await audits(listId, 'mcp_send_request')).at(-1)?.details).toMatchObject({ outcome: 'sent', receipt_status: 'unknown' });
  });

  it('a request write whose audit row cannot be written is retried whole, then refused with the owner told', async () => {
    const c = await contact();
    let calls = 0;
    // The first attempt loses its audit row (and so its write); the retry lands.
    const once = intercept('mcp_create_request', async (args) => {
      calls += 1;
      return calls === 1 ? { data: null, error: { message: 'mcp_request_audit: failed', code: 'P0001' } } : serviceClient(db).rpc('mcp_create_request', args);
    });
    const ok = await callOn(createMcpCrmHandler(liveDeps({ db: once })), 'create_request', { contact_id: c.id, title: 'Retried', items: ITEMS });
    expect([ok.isError, calls]).toEqual([false, 2]);
    expect(await q(`SELECT 1 FROM public.needs_lists WHERE contact_id = $1`, [c.id])).toHaveLength(1);

    calls = 0;
    const down = intercept('mcp_create_request', async () => {
      calls += 1;
      return { data: null, error: { message: 'mcp_request_audit: failed', code: 'P0001' } };
    });
    const out = await callOn(createMcpCrmHandler(liveDeps({ db: down })), 'create_request', { contact_id: c.id, title: 'Never', items: ITEMS });
    expect([out.isError, out.text, calls]).toEqual([true, expect.stringMatching(/^Nothing was done: the audit record could not be written.*The owner has been emailed\./), 3]);
    const alert = mail.sent.find((m) => m.subject === 'Audit trail unavailable: mcp_create_request');
    expect(alert?.to).toBe(OWNER_EMAIL);
    expect(alert?.text).toContain(`contact_id: ${c.id}`);
    expect(alert?.text).toMatch(/was NOT done/);
  });

  it('a delete whose audit row cannot be written deletes nothing and is recorded as refused', async () => {
    const c = await contact();
    const listId = await draft(c.id);
    const down = intercept('mcp_delete_request', async () => ({ data: null, error: { message: 'mcp_request_audit: failed', code: 'P0001' } }));
    const out = await callOn(createMcpCrmHandler(liveDeps({ db: down })), 'delete_request', go(listId, c.id, await tokenOf(c.id, listId)));
    expect(out.text).toMatch(/^Nothing was done: the audit record could not be written/);
    expect(await status(listId)).toBe('draft');
    expect(await trail(listId, 'mcp_delete_request')).toEqual(['refused:audit_unavailable']);
  });

  it('the outward reminder compares the reviewed version itself, whatever the recheck says', async () => {
    const r = await sentRequest();
    const outward = createRequestOutward({ store: pgliteStore(), siteUrl: SITE, ownerEmail: async () => OWNER_EMAIL });
    const [row] = await q<{ v: number }>(`SELECT content_version AS v FROM public.needs_lists WHERE id = $1`, [r.listId]);
    const log = { error() {}, warn() {}, info() {} };
    const input = { listId: r.listId, actor: DB_OWNER_ID, email: r.c.email, recheck: async () => true };
    expect(await outward.remind({ ...input, version: row.v - 1 }, log)).toEqual({ status: 'changed' });
    expect(mail.sent).toEqual([]);
    expect(await outward.remind({ ...input, version: row.v }, log)).toMatchObject({ status: 'reminded' });
  });
});
