// createHandler: the one request pipeline every edge function runs, so 30-odd functions
// answer the same way and none of them re-implements a guard.
//
// In order, for every request:
//   1. OPTIONS preflight: 204 with a CORS grant for an allowed origin, 403 without one
//      for any other origin.
//   2. Method allowlist: 405 with an Allow header.
//   3. Origin refusal: a browser request from an origin not on the list is 403 before
//      any credential is looked at (a page elsewhere must not trigger an action blind).
//   4. Authentication, by the modes the function declares:
//        owner     bearer token, authorizeOwner
//        client    bearer token, authorizeClient
//        cron      x-cron-secret against CRON_SHARED_SECRET, constant time
//        internal  a named header against a named secret, constant time
//        apiKey    a server-to-server key (x-api-key, or Authorization with or without
//                  "Bearer"), checked by the function's own verify(presented). Wrong or
//                  missing: 401. A verify that throws: 503 (it could not check), never
//                  allowed. Stands alone and must declare a rate limit, which runs after
//                  the key, so a flood of wrong keys never spends a bucket entry.
//        public    no Supabase principal. The function proves the caller itself inside
//                  handle (a signed link, a webhook signature, an API key, an OAuth
//                  token) and must declare a rate limit, which runs before that proof.
//      Modes combine (cron + owner, internal + owner, owner + client). A secret header,
//      when present, decides on its own; otherwise the bearer is tried as owner, then as
//      client. No credential or a dead session: 401. A live session of the wrong kind:
//      403. An authorizer that throws: 401 (treated as signed out, never as allowed).
//   5. clientWrites: a View-as-client session is refused, 403, before anything else.
//   6. Rate limit, when declared: before the body is read, so an abuser cannot make the
//      function buffer and parse without spending a bucket entry. 'limited' is 429,
//      'unavailable' (the limiter could not answer) is 503, and so is a throw.
//   7. The body, capped while streaming: 413 over the cap, 400 for a malformed JSON
//      body or form.
//   8. handle(ctx). Its Response is returned with the CORS and security headers and
//      Vary: Origin merged in, and a JSON body is always labelled application/json (a
//      Response built from a string defaults to text/plain); an HttpError becomes its own
//      status and public message; anything else thrown becomes a generic 500. No internal
//      message ever reaches a response body.
//
// Every response, errors included, carries Vary: Origin and the security headers.

import {
  BodyError,
  bearerToken,
  originRefused,
  presentedApiKey,
  readBodyBytes,
  readFormBody,
  readJsonBody,
  responseHeaders,
} from './http.ts';
import { MAX_TOKEN_LENGTH, type AuthOutcome, type ClientPrincipal, type OwnerPrincipal } from './auth.ts';
import { CRON_SECRET_HEADER, verifyCronSecret, verifyInternalSecret } from './secrets.ts';
import { getClientIp, type RateLimitOutcome } from './rate-limit.ts';
import { createLogger, type Logger, type LogSink } from './log.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CronPrincipal {
  kind: 'cron';
}
export interface InternalPrincipal {
  kind: 'internal';
}
export interface ApiKeyPrincipal {
  kind: 'apiKey';
}
export interface PublicPrincipal {
  kind: 'public';
}
export type Principal = OwnerPrincipal | ClientPrincipal | CronPrincipal | InternalPrincipal | ApiKeyPrincipal | PublicPrincipal;

export interface AuthModes {
  owner?: (token: string) => Promise<AuthOutcome<OwnerPrincipal>>;
  client?: (token: string) => Promise<AuthOutcome<ClientPrincipal>>;
  /** CRON_SHARED_SECRET's value. Unset or shorter than 32 characters refuses every call. */
  cron?: { secret: string | null | undefined };
  /** A function-to-function secret, e.g. { header: 'x-internal-token', secret: env ESIGN_INTERNAL_TOKEN }. */
  internal?: { header: string; secret: string | null | undefined };
  /** A server-to-server key. verify answers whether `presented` is the live key; a throw is 503. */
  apiKey?: { verify(presented: string): Promise<boolean> };
  public?: true;
}

type Fn = (...args: never[]) => unknown;
type Union<A extends AuthModes> =
  | (A extends { owner: Fn } ? OwnerPrincipal : never)
  | (A extends { client: Fn } ? ClientPrincipal : never)
  | (A extends { cron: object } ? CronPrincipal : never)
  | (A extends { internal: object } ? InternalPrincipal : never)
  | (A extends { apiKey: object } ? ApiKeyPrincipal : never)
  | (A extends { public: true } ? PublicPrincipal : never);
/** The principals a handler with these modes can see. */
export type PrincipalFor<A extends AuthModes> = [Union<A>] extends [never] ? Principal : Union<A>;

/**
 * json: required, capped. optional_json: empty body is undefined. form: multipart or
 * urlencoded, capped, then parsed. bytes: capped raw bytes. none: never read.
 */
export type BodyKind = 'json' | 'optional_json' | 'form' | 'bytes' | 'none';
export type BodyFor<K extends BodyKind> = K extends 'bytes'
  ? Uint8Array
  : K extends 'form'
    ? FormData
    : K extends 'none'
      ? undefined
      : unknown;

export interface RequestContext<P extends Principal = Principal> {
  req: Request;
  principal: P;
  /** The bearer token when owner or client auth decided the call, else null. */
  token: string | null;
  /** getClientIp(req): a real IP literal or null. */
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  log: Logger;
}

export interface HandlerContext<P extends Principal = Principal, B = unknown> extends RequestContext<P> {
  body: B;
  /** A JSON response; createHandler adds the headers. */
  json(status: number, body: unknown): Response;
}

export interface HandlerOptions<A extends AuthModes, K extends BodyKind> {
  /** The function's name, for log lines. */
  name: string;
  allowedOrigins: string[];
  /** Default ['POST']. A function that takes GET must use body 'none'. */
  methods?: readonly HttpMethod[];
  auth: A;
  /** Refuse the owner's View-as-client session (a client write function). Required with
   *  auth.client, so a client function cannot forget to decide. */
  clientWrites?: boolean;
  /** Request headers the function's protocol needs in the CORS grant, beyond BASE_ALLOW_HEADERS. Lowercase. */
  allowHeaders?: readonly string[];
  /** Runs after auth, before the body. Required with auth.public and auth.apiKey. */
  rateLimit?: (ctx: RequestContext<PrincipalFor<A>>) => Promise<RateLimitOutcome>;
  /** Default 'json'. */
  body?: K;
  /** Default 16384. */
  maxBodyBytes?: number;
  handle(ctx: HandlerContext<PrincipalFor<A>, BodyFor<K>>): Promise<Response>;
  /** Where log lines go; default console. Tests pass a collector. */
  logSink?: LogSink;
  /** Default crypto.randomUUID. */
  newRequestId?: () => string;
}

/** A refusal whose message is safe to show the caller. Throw it from handle. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly code?: string,
  ) {
    super(publicMessage);
    this.name = 'HttpError';
  }
}

interface Refusal {
  status: number;
  error: string;
  code: string;
}

/** The generic bodies every function answers with. Tests compare against these. */
export const REFUSALS = {
  methodNotAllowed: { status: 405, error: 'Method not allowed.', code: 'method_not_allowed' },
  originNotAllowed: { status: 403, error: 'Origin not allowed.', code: 'origin_not_allowed' },
  unauthenticated: { status: 401, error: 'Sign in again.', code: 'unauthenticated' },
  forbidden: { status: 403, error: 'You do not have access to this.', code: 'forbidden' },
  readOnly: { status: 403, error: 'View as client is read-only.', code: 'impersonation_read_only' },
  rateLimited: { status: 429, error: 'Too many requests. Try again later.', code: 'rate_limited' },
  unavailable: { status: 503, error: 'Temporarily unavailable. Try again later.', code: 'unavailable' },
  tooLarge: { status: 413, error: 'The request is too large.', code: 'payload_too_large' },
  badRequest: { status: 400, error: 'Bad request.', code: 'bad_request' },
  internal: { status: 500, error: 'Something went wrong. Try again.', code: 'internal' },
} as const satisfies Record<string, Refusal>;

/** For a function where only some actions write: refuse a View-as-client session here. */
export function refuseImpersonation(principal: Principal): void {
  if (principal.kind === 'client' && principal.impersonating) {
    throw new HttpError(REFUSALS.readOnly.status, REFUSALS.readOnly.error, REFUSALS.readOnly.code);
  }
}

const DEFAULT_MAX_BODY = 16_384;

type Authenticated = { principal: Principal; token: string | null };

export function createHandler<A extends AuthModes, K extends BodyKind = 'json'>(
  options: HandlerOptions<A, K>,
): (req: Request) => Promise<Response> {
  const methods: readonly HttpMethod[] = options.methods ?? ['POST'];
  const bodyKind: BodyKind = options.body ?? 'json';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const auth: AuthModes = options.auth;
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());

  // Misconfiguration fails at startup, never as an open door at request time.
  const modes = (['owner', 'client', 'cron', 'internal', 'apiKey', 'public'] as const).filter((m) => auth[m]);
  if (modes.length === 0) throw new Error(`${options.name}: declare at least one auth mode`);
  if (auth.public && modes.length > 1) throw new Error(`${options.name}: public cannot be combined with another mode`);
  if (auth.public && !options.rateLimit) throw new Error(`${options.name}: a public function must declare rateLimit`);
  if (auth.apiKey && modes.length > 1) throw new Error(`${options.name}: apiKey cannot be combined with another mode`);
  if (auth.apiKey && !options.rateLimit) throw new Error(`${options.name}: an apiKey function must declare rateLimit`);
  const allowHeaders = options.allowHeaders ?? [];
  if (allowHeaders.some((h) => !/^[a-z0-9-]+$/.test(h))) {
    throw new Error(`${options.name}: allowHeaders must be lowercase header names`);
  }
  if (options.clientWrites && !auth.client) throw new Error(`${options.name}: clientWrites needs the client mode`);
  if (auth.client && options.clientWrites === undefined) {
    throw new Error(`${options.name}: a client function must declare clientWrites`);
  }
  if (auth.internal && !/^x-[a-z0-9-]+$/.test(auth.internal.header)) {
    throw new Error(`${options.name}: an internal secret header must be a lowercase x- header`);
  }
  if (methods.includes('GET') && bodyKind !== 'none') throw new Error(`${options.name}: a GET function must use body 'none'`);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error(`${options.name}: maxBodyBytes must be a positive integer`);

  return async (req: Request): Promise<Response> => {
    const requestId = newRequestId();
    const log = createLogger(options.name, { requestId, sink: options.logSink });
    const headers = () => responseHeaders(req, options.allowedOrigins, methods, allowHeaders);
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: headers() });
    const refuse = (r: Refusal, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ error: r.error, code: r.code }), { status: r.status, headers: { ...headers(), ...extra } });

    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: originRefused(req, options.allowedOrigins) ? 403 : 204, headers: headers() });
      }
      if (!(methods as readonly string[]).includes(req.method)) {
        return refuse(REFUSALS.methodNotAllowed, { Allow: [...methods, 'OPTIONS'].join(', ') });
      }
      if (originRefused(req, options.allowedOrigins)) return refuse(REFUSALS.originNotAllowed);

      const who = await authenticate(req, auth, log);
      if ('status' in who) return refuse(who);
      if (options.clientWrites && who.principal.kind === 'client' && who.principal.impersonating) {
        return refuse(REFUSALS.readOnly);
      }

      const base: RequestContext<PrincipalFor<A>> = {
        req,
        principal: who.principal as PrincipalFor<A>,
        token: who.token,
        ip: getClientIp(req),
        userAgent: req.headers.get('user-agent'),
        requestId,
        log,
      };

      if (options.rateLimit) {
        let outcome: RateLimitOutcome;
        try {
          outcome = await options.rateLimit(base);
        } catch (err) {
          log.error('rate limit check threw; refusing', err);
          outcome = 'unavailable';
        }
        if (outcome === 'limited') return refuse(REFUSALS.rateLimited);
        if (outcome !== 'allowed') return refuse(REFUSALS.unavailable);
      }

      let body: unknown;
      try {
        body = await readBody(req, bodyKind, maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyError) return refuse(err.status === 413 ? REFUSALS.tooLarge : REFUSALS.badRequest);
        throw err;
      }

      const res = await options.handle({ ...base, body: body as BodyFor<K>, json });
      return await withHeaders(res, headers());
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status <= 599) {
        return json(err.status, err.code ? { error: err.publicMessage, code: err.code } : { error: err.publicMessage });
      }
      log.error('unhandled error', err);
      return refuse(REFUSALS.internal);
    }
  };
}

async function authenticate(req: Request, auth: AuthModes, log: Logger): Promise<Authenticated | Refusal> {
  if (auth.public) return { principal: { kind: 'public' }, token: null };
  if (auth.apiKey) {
    const presented = presentedApiKey(req);
    if (!presented) return REFUSALS.unauthenticated;
    let ok: boolean;
    try {
      ok = await auth.apiKey.verify(presented);
    } catch (err) {
      log.error('the key could not be checked; refusing', err);
      return REFUSALS.unavailable;
    }
    return ok === true ? { principal: { kind: 'apiKey' }, token: null } : REFUSALS.unauthenticated;
  }

  // A secret header, when present, decides on its own: a wrong one is refused, not
  // retried as something else.
  if (auth.cron && req.headers.has(CRON_SECRET_HEADER)) {
    if (verifyCronSecret(req, auth.cron.secret)) return { principal: { kind: 'cron' }, token: null };
    if (!auth.cron.secret) log.error('cron call refused: CRON_SHARED_SECRET is not set');
    return REFUSALS.unauthenticated;
  }
  if (auth.internal && req.headers.has(auth.internal.header)) {
    if (verifyInternalSecret(req, auth.internal.header, auth.internal.secret)) {
      return { principal: { kind: 'internal' }, token: null };
    }
    if (!auth.internal.secret) log.error('internal call refused: its secret is not set');
    return REFUSALS.unauthenticated;
  }
  if (!auth.owner && !auth.client) return REFUSALS.unauthenticated;

  const token = bearerToken(req);
  if (!token || token.length > MAX_TOKEN_LENGTH) return REFUSALS.unauthenticated;
  for (const authorize of [auth.owner, auth.client]) {
    if (!authorize) continue;
    let outcome: AuthOutcome<Principal>;
    try {
      outcome = await authorize(token);
    } catch (err) {
      log.error('authorization failed; treating as signed out', err);
      return REFUSALS.unauthenticated;
    }
    if (outcome.ok) return { principal: outcome.principal, token };
    if (outcome.status === 401) return REFUSALS.unauthenticated;
  }
  return REFUSALS.forbidden;
}

async function readBody(req: Request, kind: BodyKind, maxBytes: number): Promise<unknown> {
  if (kind === 'none') return undefined;
  if (kind === 'bytes') return readBodyBytes(req, maxBytes);
  if (kind === 'json') return readJsonBody(req, maxBytes);
  if (kind === 'form') return readFormBody(req, maxBytes);
  const bytes = await readBodyBytes(req, maxBytes);
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BodyError(400);
  }
}

/** A body that is JSON text: an object or an array that parses. */
function isJsonText(text: string): boolean {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The function's own Response, with the CORS and security headers and Vary merged in.
 * CORS is decided here alone: any Access-Control-* header the function set is dropped,
 * so a stray wildcard cannot outlive the origin check. The function's Content-Type wins
 * (set one for anything that is not JSON), with one exception: a body that carries only
 * the platform's default label, exactly `text/plain;charset=UTF-8` (any case), and is a
 * JSON object or array goes out as application/json. `new Response(JSON.stringify(x))`
 * gets that default, and a client that checks the type (an MCP connector, a fetch
 * wrapper) would then refuse a correct answer. A text/plain the function set itself, in
 * any other spelling, is its choice and stays. When the body is rebuilt, any
 * Content-Length the function set is dropped: the platform measures the new body.
 */
/** What a Response built from a string is labelled when the function sets no type. */
const PLATFORM_DEFAULT_TYPE = 'text/plain;charset=utf-8';

async function withHeaders(res: Response, ours: Record<string, string>): Promise<Response> {
  const merged = new Headers(res.headers);
  for (const key of [...merged.keys()]) {
    if (key.startsWith('access-control-')) merged.delete(key);
  }
  for (const [key, value] of Object.entries(ours)) {
    if (key === 'Content-Type' && merged.has('Content-Type')) continue;
    merged.set(key, value);
  }
  let body: BodyInit | null = res.body;
  if (res.body && (merged.get('Content-Type') ?? '').toLowerCase() === PLATFORM_DEFAULT_TYPE) {
    const text = await res.text();
    if (isJsonText(text)) merged.set('Content-Type', 'application/json');
    merged.delete('Content-Length');
    body = text;
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: merged });
}
