// mcp-oauth: the OAuth 2.1 authorization server for one protected resource, the mcp-crm
// MCP server. How an AI assistant (Claude, ChatGPT) gets a connection to this CRM:
//
//   POST /register      RFC 7591 dynamic client registration. Public clients only (PKCE,
//                       no client secret is ever issued).
//   GET  /authorize     Validates the request, parks it for ten minutes and redirects the
//                       browser to the consent screen at SITE_URL/connect. Issues nothing.
//   POST /              The consent screen's two calls, owner only and at aal2:
//                         { action: 'read', request_id }            what is being approved
//                         { action: 'decide', request_id, approve }  THE human gate: an
//                       explicit Approve mints a five-minute, single-use code; Deny ends
//                       the request too. Both answer with where to send the browser.
//   POST /token         authorization_code (PKCE S256, the code consumed atomically before
//                       anything else is checked) and refresh_token (bound to the client;
//                       rotated on every use; replaying a rotated token revokes the grant).
//   POST /revoke        RFC 7009: revokes the grant behind the token.
//   GET  /.well-known/oauth-authorization-server
//                       RFC 8414 metadata, the same document the site serves at its own
//                       /.well-known path (the issuer is SITE_URL).
//
// What each check is for:
//   * Registration confers nothing. Anyone may register; all a registration buys is the
//     right to ask the owner, and the owner's approval at aal2 is the boundary.
//   * A code is only ever sent to an EXACT allowlisted callback (origin and path, no query)
//     or to a loopback address. Registration is open and the consent screen shows a name the
//     client chose, so accepting any https callback would let anyone register "Claude" with
//     their own callback, park a request, and send the owner a first-party consent link: one
//     click would hand over a 30-day grant. Matching the host alone let a code reach any
//     path on those hosts while the screen showed only the host. The built-in list is the
//     assistants this project ships for; an adopter adds another assistant's callback with
//     MCP_EXTRA_REDIRECT_URIS (exact https addresses, comma-separated), a deliberate act of
//     configuration: it is the list of parties who may receive a code. The list is
//     re-checked at /authorize, not only at registration, so tightening it applies to
//     clients registered before. A refused registration is logged with the scheme, host and
//     path of each refused callback (never a query, credentials or fragment), so the adopter
//     can allowlist a new assistant's exact callback from the log.
//   * /authorize never redirects an error to the client's redirect_uri. Open registration
//     plus an error redirect is an open redirect on a trusted domain: register
//     https://attacker/cb, then bounce a victim there with a malformed request. Every
//     refusal is the same fixed page, which reflects nothing the caller sent. `state` is
//     required (stricter than OAuth 2.1 with PKCE), as defence in depth.
//   * Codes and tokens are 256-bit randoms stored as SHA-256 hashes. Access tokens live ten
//     minutes; refresh tokens rotate with a seven-day idle limit inside a 30-day grant.
//   * RFC 8707 `resource` is required at /authorize and /token and must name the MCP server,
//     so a token is never minted for one resource and replayed against another. On a
//     refresh it may be omitted (this server has one resource), but a wrong one is refused.
//   * Approval needs aal2, always. A password-only session must not be able to hand a
//     standing credential to a new device, so an authenticator is a prerequisite for
//     connecting an assistant. is_owner() alone would accept aal1 for an owner with no
//     factor enrolled.
//   * /revoke answers 200 for an unknown token (it reveals nothing), but a database failure
//     is a 500: a token that is still live must never be reported revoked.
//
// The door (origins, methods, rate limits, body caps, headers, generic errors) is
// createHandler's, one handler per endpoint; this file routes between them. Everything
// outside this file is injected, so the tests run it against the real migrations.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS, type RequestContext } from '../_shared/handler.ts';
import { json as jsonResponse } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { checkPublicLimits, type Limit, type RateLimitClient, type RateLimitOutcome } from '../_shared/rate-limit.ts';
import {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_ID_RE,
  PKCE_CHALLENGE_RE,
  PKCE_VERIFIER_RE,
  REFRESH_TOKEN_PREFIX,
  SCOPE,
  endpointOf,
  mcpResourceUrl,
  pkceChallenge,
} from './tokens.ts';
import { randomTokenBase64Url as randomToken, sha256Hex } from '../_shared/crypto.ts';

export const REQUEST_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_S = 600;
export const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const GRANT_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10_000;

/**
 * The parties allowed to receive a code over https, exactly (origin and path), before any
 * the adopter adds with MCP_EXTRA_REDIRECT_URIS. See the header.
 */
export const ALLOWED_REDIRECT_URIS: ReadonlySet<string> = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);

/** Loopback, for native apps (RFC 8252), which have no registrable host. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const NO_EXTRA: ReadonlySet<string> = new Set();

/**
 * An allowlisted https callback, or plain-http loopback; for either, no query, no fragment
 * and no credentials. `extra` is the adopter's own list (parseExtraRedirectUris). The fragment and
 * query are judged on the raw string, not on the parsed URL: a bare trailing '#' or '?'
 * parses to an empty hash or search and would slip past a truthiness check.
 */
export function validRedirectUri(raw: unknown, extra: ReadonlySet<string> = NO_EXTRA): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // Every scheme, loopback included: a callback carries no query and no fragment.
  if (raw.includes('#') || raw.includes('?') || u.username || u.password) return false;
  if (u.protocol === 'https:') {
    const target = `${u.origin}${u.pathname}`;
    return ALLOWED_REDIRECT_URIS.has(target) || extra.has(target);
  }
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * MCP_EXTRA_REDIRECT_URIS: comma-separated exact https callbacks the adopter allows beyond
 * the built-in list, each stored as origin and path. An entry that is not a plain https
 * address (a query, a fragment, credentials, another scheme, or not a URL at all) is
 * refused and returned in `rejected`, so the function can log it; it never widens the list.
 */
export function parseExtraRedirectUris(raw: string | undefined): { uris: string[]; rejected: string[] } {
  const uris: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    let u: URL | null = null;
    try {
      u = new URL(entry);
    } catch {
      u = null;
    }
    if (!u || u.protocol !== 'https:' || entry.includes('?') || entry.includes('#') || u.username || u.password || entry.length > 500) {
      rejected.push(u ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 200) : '<unparseable>');
      continue;
    }
    uris.push(`${u.origin}${u.pathname}`);
  }
  return { uris, rejected };
}

/**
 * The refused callbacks of a registration, as a log may carry them: only the refused
 * entries, at most five, and only the scheme, host and path of each. A query, credentials
 * or a fragment can carry personal data or a secret; a value that is not a string is named
 * by its type.
 */
export function rejectedCallbacks(value: unknown, extra: ReadonlySet<string> = NO_EXTRA): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.slice(0, 5).filter((u) => !validRedirectUri(u, extra)).map((u) => {
    if (typeof u !== 'string') return `<${u === null ? 'null' : typeof u}>`;
    try {
      const p = new URL(u);
      return `${p.protocol}//${p.host}${p.pathname}`.slice(0, 200);
    } catch {
      return '<unparseable>';
    }
  });
}

/**
 * The `aal` claim of an access token. Reads the payload without checking the signature, so
 * call it only on a token Auth has already accepted (authorizeOwner has, before handle runs).
 */
export function jwtAal(token: string): string | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { aal?: unknown };
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
}

/** RFC 8414 metadata. The issuer is the site, so the site's own /.well-known path serves it. */
export function authorizationServerMetadata(siteUrl: string, supabaseUrl: string): Record<string, unknown> {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp-oauth`;
  return {
    issuer: siteUrl,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

/** The slice of a Supabase service client this function calls. supabase-js satisfies it. */
export interface McpOauthDb extends RateLimitClient {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }> };
}

export interface McpOauthDeps {
  allowedOrigins: string[];
  supabaseUrl: string;
  /** The issuer and the consent screen's origin. Null refuses every flow that needs it. */
  siteUrl: string | null;
  /** _shared/auth.ts authorizeOwner, bound to the function's clients. */
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** The aal of a token authorizeOwner accepted: jwtAal. */
  sessionAal(token: string): string | null;
  db: McpOauthDb;
  /** The rate limiter; checkPublicLimits against db when omitted. Tests pass a fake. */
  limit?: (action: string, ctx: RequestContext, limits: { perIp: Limit; global: Limit }) => Promise<RateLimitOutcome>;
  logSink?: LogSink;
  now?: () => number;
  /** The adopter's extra https callbacks (parseExtraRedirectUris over MCP_EXTRA_REDIRECT_URIS). */
  extraRedirectUris?: readonly string[];
}

const LIMITS = {
  register: { perIp: { max: 10, windowMinutes: 60 }, global: { max: 100, windowMinutes: 60 } },
  authorize: { perIp: { max: 20, windowMinutes: 60 }, global: { max: 200, windowMinutes: 60 } },
  token: { perIp: { max: 60, windowMinutes: 60 }, global: { max: 600, windowMinutes: 60 } },
  revoke: { perIp: { max: 60, windowMinutes: 60 }, global: { max: 600, windowMinutes: 60 } },
  metadata: { perIp: { max: 60, windowMinutes: 60 }, global: { max: 1000, windowMinutes: 60 } },
} as const;

/** The one page every /authorize refusal renders. Fixed text: nothing the caller sent is reflected. */
function refusalPage(status = 400): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Connection request refused</title>' +
      '<h1>This connection request could not be validated</h1>' +
      '<p>The requesting app or its return address is not recognized. Nothing was authorized. ' +
      'Close this tab and try adding the connector again.</p>',
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// Every JSON body this file builds itself names its type: a Response made from a string
// defaults to text/plain, and the shared door keeps a Content-Type the function set.
const oauthError = (status: number, error: string, description: string): Response =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Each endpoint's handler, exported so the tests can hold each to the edge contract. */
export function createMcpOauthEndpoints(deps: McpOauthDeps) {
  const now = deps.now ?? (() => Date.now());
  const extra: ReadonlySet<string> = new Set(deps.extraRedirectUris ?? []);
  const resource = mcpResourceUrl(deps.supabaseUrl);
  const limiter = (action: keyof typeof LIMITS) => (ctx: RequestContext) =>
    deps.limit
      ? deps.limit(`mcp_oauth_${action}`, ctx, LIMITS[action])
      : checkPublicLimits(deps.db, { action: `mcp_oauth_${action}`, ip: ctx.ip, userAgent: ctx.userAgent, ...LIMITS[action] });
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await deps.db.rpc(fn, args);
    if (error) throw error;
    return data as T;
  };
  const common = { allowedOrigins: deps.allowedOrigins, logSink: deps.logSink } as const;

  const consent = createHandler({
    ...common,
    name: 'mcp-oauth',
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 1024,
    async handle({ principal, token, body, json, ip, userAgent }) {
      if (deps.sessionAal(token ?? '') !== 'aal2') {
        throw new HttpError(403, 'Approving a connection needs a two-factor sign-in.', 'mfa_required');
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const requestId = str(b.request_id);
      if (!requestId || requestId.length > 200 || (b.action !== 'read' && b.action !== 'decide')) {
        throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      }
      const gone = { error: 'This connection request was not found or has expired.', code: 'not_found' };

      if (b.action === 'read') {
        const info = await rpc<Record<string, unknown> | null>('mcp_oauth_pending_request', { p_request_id: requestId });
        return info ? json(200, info) : json(404, gone);
      }

      if (typeof b.approve !== 'boolean') {
        throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      }
      // The version of the wording the owner was shown; an approval needs one. The database
      // refuses any but the current version, so a screen loaded before an upgrade cannot
      // approve the new powers on the old wording.
      const version = b.consent_version;
      if (b.approve && !(Number.isInteger(version) && (version as number) > 0 && (version as number) < 1_000_000)) {
        throw new HttpError(REFUSALS.badRequest.status, REFUSALS.badRequest.error, REFUSALS.badRequest.code);
      }
      const code = b.approve ? randomToken() : null;
      let decided: { redirect_uri: string; state: string; client_id: string } | null;
      try {
        decided = await rpc('mcp_oauth_decide', {
          p_request_id: requestId,
          p_approve: b.approve,
          p_code_hash: code ? await sha256Hex(code) : null,
          p_code_expires: code ? new Date(now() + CODE_TTL_MS).toISOString() : null,
          p_consent_version: b.approve ? version : null,
          p_actor: principal.userId,
          p_ip: ip,
          p_user_agent: userAgent,
        });
      } catch (err) {
        if (String((err as { message?: unknown })?.message ?? '').includes('mcp_oauth_decide: stale_consent')) {
          return json(409, {
            error: 'What a connection may do has changed since this page opened. Reload the page, read it again, then answer.',
            code: 'consent_changed',
          });
        }
        throw err;
      }
      if (!decided) return json(404, gone);

      // Built here, never in the browser: the page only assigns what it is given.
      const to = new URL(decided.redirect_uri);
      if (code) {
        to.searchParams.set('code', code);
      } else {
        to.searchParams.set('error', 'access_denied');
        to.searchParams.set('error_description', 'The request was denied');
      }
      to.searchParams.set('state', decided.state);
      return json(200, { redirect_to: to.toString() });
    },
  });

  const authorize = createHandler({
    ...common,
    name: 'mcp-oauth',
    methods: ['GET'],
    auth: { public: true },
    rateLimit: limiter('authorize'),
    body: 'none',
    async handle({ req, log }) {
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; refusing to authorize');
        return refusalPage(500);
      }
      const q = new URL(req.url).searchParams;
      const clientId = q.get('client_id') ?? '';
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!CLIENT_ID_RE.test(clientId)) return refusalPage();
      const client = await rpc<{ redirect_uris: string[] } | null>('mcp_oauth_client', { p_client_id: clientId });
      // An unknown client or an unregistered redirect is refused on the spot: these two
      // decide where a code would land, and are never redirected to.
      if (!client || !client.redirect_uris.includes(redirectUri) || !validRedirectUri(redirectUri, extra)) return refusalPage();

      const state = q.get('state') ?? '';
      const challenge = q.get('code_challenge') ?? '';
      if (
        q.get('response_type') !== 'code' ||
        !state ||
        state.length > 1000 ||
        !PKCE_CHALLENGE_RE.test(challenge) ||
        q.get('code_challenge_method') !== 'S256' ||
        (q.get('scope') ?? SCOPE) !== SCOPE ||
        q.get('resource') !== resource
      ) {
        return refusalPage();
      }

      const requestId = randomToken();
      const { error } = await deps.db.from('mcp_oauth_requests').insert({
        request_id: requestId,
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        scope: SCOPE,
        resource,
        expires_at: new Date(now() + REQUEST_TTL_MS).toISOString(),
      });
      if (error) throw error;
      return new Response(null, {
        status: 302,
        headers: { Location: `${deps.siteUrl}/connect?request=${encodeURIComponent(requestId)}` },
      });
    },
  });

  const register = createHandler({
    ...common,
    name: 'mcp-oauth',
    auth: { public: true },
    rateLimit: limiter('register'),
    maxBodyBytes: MAX_BODY_BYTES,
    async handle({ body, json, log }) {
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
      if (uris.length < 1 || uris.length > 5 || !uris.every((u) => validRedirectUri(u, extra))) {
        // Names the exact callback a new assistant would need allowlisted. JSON.stringify
        // escapes control characters, so a caller's value cannot forge a log line. The
        // client name is not logged: it is free text the caller chose, and could carry a
        // code or a credential.
        log.warn(
          `register refused redirect_uris=${JSON.stringify(rejectedCallbacks(b.redirect_uris, extra))}`,
          { count: Array.isArray(b.redirect_uris) ? b.redirect_uris.length : 0 },
        );
        return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be 1 to 5 recognized callback addresses');
      }
      if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
        return oauthError(400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none) are supported');
      }
      const grants = b.grant_types === undefined ? ['authorization_code'] : b.grant_types;
      if (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
        return oauthError(400, 'invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported');
      }
      const responseTypes = b.response_types === undefined ? ['code'] : b.response_types;
      if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
        return oauthError(400, 'invalid_client_metadata', 'Only response_type code is supported');
      }
      const name = typeof b.client_name === 'string' ? b.client_name.replace(/[\r\n\0]/g, ' ').trim().slice(0, 100) || null : null;

      const clientId = `${CLIENT_ID_PREFIX}${randomToken()}`;
      const { error } = await deps.db.from('mcp_oauth_clients').insert({ client_id: clientId, client_name: name, redirect_uris: uris });
      if (error) throw error;

      // Hygiene only: a failure here must not fail the registration that just succeeded.
      try {
        const { error: cleanupError } = await deps.db.rpc('mcp_oauth_cleanup', {});
        if (cleanupError) log.error('cleanup failed', cleanupError);
      } catch (err) {
        log.error('cleanup failed', err);
      }

      return json(201, {
        client_id: clientId,
        ...(name ? { client_name: name } : {}),
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      });
    },
  });

  const tokenEndpoint = createHandler({
    ...common,
    name: 'mcp-oauth',
    auth: { public: true },
    rateLimit: limiter('token'),
    body: 'form',
    maxBodyBytes: MAX_BODY_BYTES,
    async handle({ body, json, ip, userAgent, log }) {
      const param = (key: string) => str(body.get(key));
      const grantType = param('grant_type');
      const at = now();
      const accessToken = `${ACCESS_TOKEN_PREFIX}${randomToken()}`;
      const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomToken()}`;
      const issued = (scope: string) =>
        json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope });

      if (grantType === 'authorization_code') {
        const code = param('code');
        const verifier = param('code_verifier');
        if (!code || code.length > 200 || !PKCE_VERIFIER_RE.test(verifier)) {
          return oauthError(400, 'invalid_grant', 'Missing or malformed code or code_verifier');
        }
        // Required, with no fallback: an exchange that names no audience is refused.
        if (param('resource') !== resource) {
          return oauthError(400, 'invalid_target', 'resource must name the MCP server URL');
        }

        // Consume FIRST: a code is single-use even when the rest of the exchange fails.
        const consumed = await rpc<{
          client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string;
          approved_by: string | null; approved_at: string | null; consent_version: number | null;
        } | null>('mcp_oauth_consume_code', { p_code_hash: await sha256Hex(code) });
        if (!consumed) return oauthError(400, 'invalid_grant', 'The code is invalid, expired, or already used');
        const mismatch =
          consumed.client_id !== param('client_id')
            ? 'client'
            : consumed.redirect_uri !== param('redirect_uri')
              ? 'redirect'
              : consumed.resource !== resource
                ? 'resource'
                : consumed.code_challenge !== (await pkceChallenge(verifier))
                  ? 'verifier'
                  : null;
        if (mismatch) {
          // An approved code presented wrongly is worth a record: it is what an intercepted
          // code looks like. The refusal stands whether or not the record is written.
          if (consumed.approved_by) {
            const { error: auditError } = await deps.db.rpc('mcp_audit_row', {
              p_actor: consumed.approved_by,
              p_action: 'mcp_oauth_code_rejected',
              p_details: { source: 'mcp_oauth', client_id: consumed.client_id, reason: mismatch },
              p_ip: ip,
              p_user_agent: userAgent,
            });
            if (auditError) log.error('could not record a rejected code exchange', auditError);
          }
          return oauthError(400, 'invalid_grant', 'The exchange does not match the authorized request');
        }

        const { error } = await deps.db.rpc('mcp_oauth_create_grant', {
          p_client_id: consumed.client_id,
          p_scope: consumed.scope,
          p_access_hash: await sha256Hex(accessToken),
          p_access_expires: new Date(at + ACCESS_TTL_S * 1000).toISOString(),
          p_refresh_hash: await sha256Hex(refreshToken),
          p_refresh_expires: new Date(at + REFRESH_IDLE_MS).toISOString(),
          p_absolute_expires: new Date(at + GRANT_ABSOLUTE_MS).toISOString(),
          p_approved_by: consumed.approved_by,
          p_approved_at: consumed.approved_at,
          p_consent_version: consumed.consent_version,
          p_ip: ip,
          p_user_agent: userAgent,
        });
        if (error) {
          // The person who approved is no longer the owner: nothing to issue. Or an MFA
          // recovery of theirs landed after the approval. Or the approval was given on
          // older consent wording than the connector now needs.
          const message = String((error as { message?: unknown }).message ?? '');
          if (message.includes('approver_not_owner') || message.includes('approval_revoked') || message.includes('stale_consent')) {
            return oauthError(400, 'invalid_grant', 'The approval is no longer valid');
          }
          throw error;
        }
        return issued(consumed.scope);
      }

      if (grantType === 'refresh_token') {
        const presented = param('refresh_token');
        if (!presented || presented.length > 200) return oauthError(400, 'invalid_grant', 'Missing refresh_token');
        const named = body.get('resource');
        if (named !== null && named !== resource) {
          return oauthError(400, 'invalid_target', 'resource must name the MCP server URL');
        }
        const result = await rpc<{ status: string; scope?: string }>('mcp_oauth_rotate_refresh', {
          p_old_hash: await sha256Hex(presented),
          // A client_id that is sent must be the grant's. One left out is allowed (not every
          // connector sends it on a refresh); rotation and replay detection still guard it.
          p_client_id: body.get('client_id'),
          p_access_hash: await sha256Hex(accessToken),
          p_access_expires: new Date(at + ACCESS_TTL_S * 1000).toISOString(),
          p_refresh_hash: await sha256Hex(refreshToken),
          p_refresh_idle_expires: new Date(at + REFRESH_IDLE_MS).toISOString(),
          p_ip: ip,
          p_user_agent: userAgent,
        });
        if (result?.status === 'replayed') {
          log.warn('refresh token replayed; grant revoked');
          return oauthError(400, 'invalid_grant', 'This refresh token was already used, so the connection was revoked. Connect again.');
        }
        if (result?.status !== 'ok') return oauthError(400, 'invalid_grant', 'The refresh token is invalid or expired');
        return issued(result.scope ?? SCOPE);
      }

      return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
    },
  });

  const revoke = createHandler({
    ...common,
    name: 'mcp-oauth',
    auth: { public: true },
    rateLimit: limiter('revoke'),
    body: 'form',
    maxBodyBytes: MAX_BODY_BYTES,
    async handle({ body, json, ip, userAgent }) {
      const presented = str(body.get('token'));
      if (presented && presented.length <= 200) {
        // An unknown token is false (still 200); a database error throws, and is a 500.
        await rpc<boolean>('mcp_oauth_revoke_token', { p_token_hash: await sha256Hex(presented), p_ip: ip, p_user_agent: userAgent });
      }
      return json(200, {});
    },
  });

  const metadata = createHandler({
    ...common,
    name: 'mcp-oauth',
    methods: ['GET'],
    auth: { public: true },
    rateLimit: limiter('metadata'),
    body: 'none',
    handle({ json, log }) {
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; no issuer to publish');
        throw new HttpError(REFUSALS.internal.status, REFUSALS.internal.error, REFUSALS.internal.code);
      }
      return Promise.resolve(json(200, authorizationServerMetadata(deps.siteUrl, deps.supabaseUrl)));
    },
  });

  return { consent, authorize, register, token: tokenEndpoint, revoke, metadata };
}

/** The function: routes the subpath to its endpoint. An unknown path is a 404 with the usual headers. */
export function createMcpOauthHandler(deps: McpOauthDeps): (req: Request) => Promise<Response> {
  const e = createMcpOauthEndpoints(deps);
  const routes: Record<string, (req: Request) => Promise<Response>> = {
    '': e.consent,
    authorize: e.authorize,
    register: e.register,
    token: e.token,
    revoke: e.revoke,
    '.well-known/oauth-authorization-server': e.metadata,
  };
  return (req) => {
    const endpoint = endpointOf(req.url, 'mcp-oauth');
    // Own keys only: a path like 'constructor' must not reach Object.prototype.
    const route = endpoint !== null && Object.hasOwn(routes, endpoint) ? routes[endpoint] : undefined;
    if (!route) return Promise.resolve(jsonResponse(req, deps.allowedOrigins, 404, { error: 'Not found.', code: 'not_found' }));
    return route(req);
  };
}
