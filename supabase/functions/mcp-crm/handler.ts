// mcp-crm: the remote MCP server an AI assistant (Claude, ChatGPT) uses to work in this CRM.
//
// Transport: Streamable HTTP (MCP 2025-11-25). One endpoint; POST carries JSON-RPC, a
// batch or a single message, and every answer is application/json. Nothing here runs long,
// so this server never opens a stream, and GET is answered 405 as the spec allows. GET on
// /.well-known/oauth-protected-resource serves the RFC 9728 metadata a connector follows
// to find the OAuth server.
//
// This endpoint is a STANDING CREDENTIAL TO THE WHOLE CONTACT LIST, a different risk class
// from a page behind an interactive session. What follows from that, none of it optional:
//   1. OAuth only. The bearer must be an access token mcp-oauth minted, on a live grant the
//      owner approved at aal2, and its approver must still be the owner. There is no
//      anonymous path, no client path and no static token.
//   2. The gateway's JWT check is off for this function (a connector cannot mint a
//      Supabase JWT), so the token check here IS the authentication boundary.
//   3. Connectors call from their provider's cloud, so no address allowlist is possible and
//      Origin is usually absent. An absent Origin is allowed; a present one that is not on
//      the list is refused (the spec's DNS-rebinding rule).
//   4. A token of the wrong shape is refused before any database lookup; only a well-formed
//      token reaches the single indexed hash lookup. The per-address rate limit runs first
//      for every request: it is what bounds a guessing campaign. A failed authentication is
//      logged with the caller's address.
//   5. Every read and every write is audited with source 'mcp', inside the same transaction
//      (see tools.ts and 0007_mcp.sql). The two tools that email a client audit after the
//      fact, since an email cannot be rolled back, and allow one such email per request.
//      A sign-in address change audits its database half in that half's transaction, and a
//      half-finished one (the sign-in moved, the record did not) after the fact.
//   6. A request is bounded: 100,000 bytes of body, 20 messages per batch, 20 tool calls per
//      request. Batches run serially and each element can cost a database round trip, so
//      an uncapped batch would turn one request into any number of writes.

import { createHandler, HttpError, REFUSALS, type RequestContext } from '../_shared/handler.ts';
import { bearerToken, json as jsonResponse } from '../_shared/http.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import { checkPublicLimits, type RateLimitOutcome } from '../_shared/rate-limit.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { ACCESS_TOKEN_RE, SCOPE, endpointOf, mcpResourceUrl, protectedResourceMetadataUrl } from '../mcp-oauth/tokens.ts';
import type { RequestOutward } from './outward.ts';
import type { ReviewSigner } from './review-token.ts';
import { TOOL_NAMES, callTool, toolCatalog, type PrivilegedOps, type ToolDb, type Vocabulary } from './tools.ts';

export const PROTOCOL_VERSION = '2025-11-25';
export const SERVER_INFO = { name: 'open-crm', version: '1.0.0' } as const;
export const MAX_BODY_BYTES = 100_000;
export const MAX_BATCH = 20;
export const MAX_TOOL_CALLS = 20;

/**
 * Browser origins a connector may present, beyond the app's own. Adding one is a code
 * change. (The OAuth callback list is wider: an adopter adds a callback with
 * MCP_EXTRA_REDIRECT_URIS, see mcp-oauth.)
 */
export const CONNECTOR_ORIGINS = ['https://claude.ai'];

export interface McpCrmDeps {
  /** The app's origins (config.allowedOrigins); CONNECTOR_ORIGINS are added here. */
  allowedOrigins: string[];
  supabaseUrl: string;
  /** The OAuth issuer. Null refuses to serve: a connector could never find the OAuth server. */
  siteUrl: string | null;
  db: ToolDb;
  /** The answer key, Storage and Auth, for the tools that need them (createPrivilegedOps in index.ts). */
  privileged: PrivilegedOps;
  /** org_profile.display_name, for the metadata's resource_name. */
  orgName(): Promise<string>;
  /** Mints and verifies the request tools' review tokens (createReviewSigner over a server secret). */
  review: ReviewSigner;
  /** Sends and reminds a request in process, and emails the owner (createRequestOutward). */
  outward: RequestOutward;
  /** The wait between audit attempts of an outward act; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** The rate limiter; checkPublicLimits against db when omitted. Tests pass a fake. */
  limit?: (action: string, ctx: RequestContext) => Promise<RateLimitOutcome>;
  logSink?: LogSink;
}

const LIMITS = {
  rpc: { perIp: { max: 600, windowMinutes: 10 }, global: { max: 3000, windowMinutes: 10 } },
  metadata: { perIp: { max: 60, windowMinutes: 60 }, global: { max: 1000, windowMinutes: 60 } },
} as const;

/** What mcp_oauth_authenticate answers for a live token. */
interface Grant {
  grant_id: string;
  actor: string;
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });

/**
 * A JSON reply this file builds itself. The type is named: a Response made from a string
 * defaults to text/plain, and the shared door keeps a Content-Type the function set.
 */
const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** A JSON-RPC id is a string, a number or null; absent means a notification. */
const validId = (id: unknown) => id === undefined || id === null || typeof id === 'string' || typeof id === 'number';

/**
 * The Streamable HTTP transport's own request headers. A browser-based connector sends them
 * on every request after initialize, so the CORS grant must name them or its preflight fails.
 */
export const MCP_ALLOW_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;

/** Each endpoint's handler, exported so the tests can hold each to the edge contract. */
export function createMcpCrmEndpoints(deps: McpCrmDeps) {
  const allowedOrigins = [...new Set([...deps.allowedOrigins, ...CONNECTOR_ORIGINS])];
  const resource = mcpResourceUrl(deps.supabaseUrl);
  const limiter = (action: keyof typeof LIMITS) => (ctx: RequestContext) =>
    deps.limit
      ? deps.limit(`mcp_crm_${action}`, ctx)
      : checkPublicLimits(deps.db, { action: `mcp_crm_${action}`, ip: ctx.ip, userAgent: ctx.userAgent, ...LIMITS[action] });

  const unauthenticated = (): Response =>
    jsonReply(
      REFUSALS.unauthenticated.status,
      { error: REFUSALS.unauthenticated.error, code: REFUSALS.unauthenticated.code },
      { 'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(deps.supabaseUrl)}"` },
    );

  const rpcEndpoint = createHandler({
    name: 'mcp-crm',
    allowedOrigins,
    allowHeaders: MCP_ALLOW_HEADERS,
    auth: { public: true },
    rateLimit: limiter('rpc'),
    body: 'bytes',
    maxBodyBytes: MAX_BODY_BYTES,
    logSink: deps.logSink,
    async handle({ req, body, ip, userAgent, log }) {
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; refusing to serve');
        throw new HttpError(REFUSALS.internal.status, REFUSALS.internal.error, REFUSALS.internal.code);
      }

      // THE authentication boundary. Shape first, with no database work for a malformed token.
      const token = bearerToken(req);
      let grant: Grant | null = null;
      if (token && ACCESS_TOKEN_RE.test(token)) {
        const { data, error } = await deps.db.rpc('mcp_oauth_authenticate', { p_access_hash: await sha256Hex(token) });
        if (error) throw error;
        grant = data as Grant | null;
      }
      if (!grant) {
        log.warn('authentication failed', { ip });
        return unauthenticated();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return jsonReply(400, rpcErr(null, -32700, 'Parse error'));
      }
      const isBatch = Array.isArray(parsed);
      const messages = isBatch ? (parsed as unknown[]) : [parsed];
      if (isBatch && messages.length === 0) {
        return jsonReply(400, rpcErr(null, -32600, 'Invalid Request'));
      }
      if (messages.length > MAX_BATCH) {
        return jsonReply(413, rpcErr(null, -32600, `Batch too large (max ${MAX_BATCH} messages)`));
      }

      let vocab: Promise<Vocabulary> | null = null;
      const vocabulary = () =>
        (vocab ??= (async () => {
          const { data, error } = await deps.db.rpc('mcp_tool_vocabulary', {});
          if (error) throw error;
          return data as Vocabulary;
        })());
      const ctx = {
        db: deps.db, privileged: deps.privileged, actor: grant.actor, ip, userAgent, vocabulary, budget: { sends: 0 },
        review: deps.review, outward: deps.outward, log, sleep: deps.sleep,
      };
      let toolCalls = 0;
      const responses: unknown[] = [];

      for (const raw of messages) {
        const msg = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as RpcMessage | null;
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !validId(msg.id)) {
          responses.push(rpcErr(msg && validId(msg.id) ? (msg.id ?? null) : null, -32600, 'Invalid Request'));
          continue;
        }
        const { id, method } = msg;
        // A notification gets no answer, so nothing is run for one: a tool call nobody can
        // read the result of would be a write with no report.
        if (id === undefined || id === null) continue;
        try {
          const result = await dispatch(method, msg.params, () => ++toolCalls, ctx, log);
          responses.push(result.error ? rpcErr(id, result.error.code, result.error.message) : rpcOk(id, result.ok));
        } catch (err) {
          // Generic to the caller; the log line is redacted (errSummary keeps the SQLSTATE
          // and message, never a failing row's values).
          log.error('message failed', err, { method });
          responses.push(rpcErr(id, -32603, 'Internal error'));
        }
      }

      // An all-notification batch gets 202 and no body, per the transport spec.
      if (responses.length === 0) return new Response(null, { status: 202 });
      return jsonReply(200, isBatch ? responses : responses[0]);
    },
  });

  const metadata = createHandler({
    name: 'mcp-crm',
    allowedOrigins,
    allowHeaders: MCP_ALLOW_HEADERS,
    methods: ['GET'],
    auth: { public: true },
    rateLimit: limiter('metadata'),
    body: 'none',
    logSink: deps.logSink,
    async handle({ json, log }) {
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; no authorization server to name');
        throw new HttpError(REFUSALS.internal.status, REFUSALS.internal.error, REFUSALS.internal.code);
      }
      return json(200, {
        resource,
        authorization_servers: [deps.siteUrl],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ['header'],
        resource_name: await deps.orgName(),
      });
    },
  });

  return { rpc: rpcEndpoint, metadata };
}

type Dispatched = { ok: unknown; error?: undefined } | { error: { code: number; message: string }; ok?: undefined };

async function dispatch(
  method: string,
  params: unknown,
  countToolCall: () => number,
  ctx: Parameters<typeof callTool>[2],
  log: Logger,
): Promise<Dispatched> {
  if (method === 'initialize') {
    return { ok: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } };
  }
  if (method === 'ping') return { ok: {} };
  if (method === 'tools/list') return { ok: { tools: toolCatalog(await ctx.vocabulary()) } };
  if (method === 'tools/call') {
    const p = (params && typeof params === 'object' ? params : {}) as { name?: unknown; arguments?: unknown };
    const name = typeof p.name === 'string' ? p.name : '';
    if (countToolCall() > MAX_TOOL_CALLS) return { error: { code: -32600, message: 'Too many tool calls in one request' } };
    if (!TOOL_NAMES.includes(name)) return { error: { code: -32602, message: 'Unknown tool' } };
    const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
    const result = await callTool(name, args, ctx);
    log.info('tool called', { tool: name, refused: result.isError === true });
    return { ok: result };
  }
  return { error: { code: -32601, message: 'Method not found' } };
}

/** The function: routes the subpath to its endpoint. An unknown path is a 404 with the usual headers. */
export function createMcpCrmHandler(deps: McpCrmDeps): (req: Request) => Promise<Response> {
  const e = createMcpCrmEndpoints(deps);
  const routes: Record<string, (req: Request) => Promise<Response>> = {
    '': e.rpc,
    '.well-known/oauth-protected-resource': e.metadata,
  };
  return (req) => {
    const endpoint = endpointOf(req.url, 'mcp-crm');
    // Own keys only: a path like 'constructor' must not reach Object.prototype.
    const route = endpoint !== null && Object.hasOwn(routes, endpoint) ? routes[endpoint] : undefined;
    if (!route) return Promise.resolve(jsonResponse(req, deps.allowedOrigins, 404, { error: 'Not found.', code: 'not_found' }));
    return route(req);
  };
}
