import type { BrowserContext, Request, Route, WebSocketRoute } from '@playwright/test';
import { makeAccessToken, readToken } from './jwt';
import { matches, page, project, type Row } from './postgrest';

/**
 * The fake Supabase project every spec runs against: Auth, PostgREST, edge functions, Storage
 * and Realtime, served from memory by Playwright route interception. Nothing here reaches a
 * network: the origin below does not resolve, and every request to it is fulfilled here.
 */

export const MOCK_ORIGIN = 'http://supabase.mock.test';
/** Not a key: the app only needs something non-empty to send as `apikey`. */
export const MOCK_ANON_KEY = 'mock-anon-key-0123456789';
/** supabase-js names its storage key after the first label of the project's host. */
export const AUTH_STORAGE_KEY = 'sb-supabase-auth-token';

export type Principal = 'owner' | 'client' | 'anon';

export interface MockUser {
  id: string;
  email: string;
  password: string;
  principal: Exclude<Principal, 'anon'>;
  /** A verified authenticator: signing in needs the second step. */
  totpFactorId?: string;
}

export interface CallContext {
  principal: Principal;
  user: MockUser | null;
  /** The token's assurance level (aal1 or aal2), or null for the anon key. */
  aal: string | null;
  /** A table of the mock project, for a handler that reads or writes rows. */
  table: (name: string) => Row[];
  /** A fresh row id. */
  newId: () => string;
}

export interface FnRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** The parsed JSON body, or null for none or a non-JSON body. */
  json: unknown;
  /** The raw body bytes (an upload). */
  body: Buffer | null;
}

export interface FnResponse {
  status?: number;
  json?: unknown;
  body?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type FnHandler = (req: FnRequest, ctx: CallContext) => FnResponse | Promise<FnResponse>;
export type RpcHandler = unknown | ((args: Record<string, unknown>, ctx: CallContext) => unknown);

/** One request the mock answered, kept for assertions. */
export interface Call {
  kind: 'auth' | 'rest' | 'rpc' | 'functions' | 'storage';
  method: string;
  /** Path below the service prefix: a table, an RPC or function name, an object path. */
  name: string;
  url: string;
  json: unknown;
  body: Buffer | null;
  principal: Principal;
}

export interface Scenario {
  users: MockUser[];
  tables: Record<string, Row[]>;
  rpc: Record<string, RpcHandler>;
  functions: Record<string, FnHandler>;
  /** Object bytes by `<bucket>/<path>`; anything else downloads `defaultFile`. */
  files: Record<string, Buffer>;
  defaultFile: Buffer | null;
  /** Column defaults per table, applied to an inserted row (what the database would fill in). */
  defaults: Record<string, Row>;
}

/** Return one from an RPC handler to answer with a PostgREST error. */
export class RpcError {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
  ) {}
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): FnResponse => ({ status, json: value, headers });

function sessionFor(user: MockUser, aal: 'aal1' | 'aal2') {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = `session-${user.id.slice(-4)}`;
  return {
    access_token: makeAccessToken({ sub: user.id, email: user.email, aal, sessionId }),
    refresh_token: `refresh-${user.id.slice(-4)}-${aal}`,
    token_type: 'bearer',
    expires_in: 86_400,
    expires_at: now + 86_400,
    user: authUser(user),
  };
}

function authUser(user: MockUser) {
  const at = '2026-01-05T09:00:00Z';
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: at,
    confirmed_at: at,
    last_sign_in_at: at,
    created_at: at,
    updated_at: at,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    factors: user.totpFactorId
      ? [{ id: user.totpFactorId, friendly_name: 'Authenticator', factor_type: 'totp', status: 'verified', created_at: at, updated_at: at }]
      : [],
  };
}

export class MockSupabase {
  readonly scenario: Scenario;
  /** Every request the mock answered, in order. */
  readonly calls: Call[] = [];
  /** Requests the scenario had no answer for (a table read is never one: unknown tables are empty). */
  readonly unhandled: string[] = [];
  private nextId = 1;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  table(name: string): Row[] {
    this.scenario.tables[name] ??= [];
    return this.scenario.tables[name];
  }

  user(principal: Exclude<Principal, 'anon'>): MockUser {
    const found = this.scenario.users.find((u) => u.principal === principal);
    if (!found) throw new Error(`No ${principal} user in this scenario`);
    return found;
  }

  /** A signed-in session for this user, as supabase-js keeps it in localStorage. */
  session(principal: Exclude<Principal, 'anon'>, aal: 'aal1' | 'aal2' = 'aal2') {
    return sessionFor(this.user(principal), aal);
  }

  /** Calls of one kind, optionally to one name. */
  callsTo(kind: Call['kind'], name?: string): Call[] {
    return this.calls.filter((c) => c.kind === kind && (name === undefined || c.name === name));
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${MOCK_ORIGIN}/**`, (route) => this.handle(route));
    await context.routeWebSocket(/^wss?:\/\/supabase\.mock\.test\//, (ws) => this.realtime(ws));
  }

  newId(): string {
    const n = (this.nextId++).toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${n.replace(/^0/, 'f')}`;
  }

  private context(request: Request): CallContext {
    const bearer = request.headers()['authorization']?.replace(/^Bearer\s+/i, '');
    const claims = readToken(bearer);
    const user = claims ? this.scenario.users.find((u) => u.id === claims.sub) ?? null : null;
    return { principal: user?.principal ?? 'anon', user, aal: claims?.aal ?? null, table: (name) => this.table(name), newId: () => this.newId() };
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const ctx = this.context(request);
    const body = request.postDataBuffer();
    let parsed: unknown = null;
    if (body && body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        parsed = null;
      }
    }
    const req: FnRequest = { method: request.method(), url, headers: request.headers(), json: parsed, body };
    const [, service, version, ...rest] = url.pathname.split('/');
    const tail = rest.join('/');
    let result: FnResponse;

    if (request.method() === 'OPTIONS') {
      result = { status: 204 };
    } else if (service === 'auth' && version === 'v1') {
      this.record('auth', req, tail, ctx);
      result = this.auth(req, tail, ctx);
    } else if (service === 'rest' && version === 'v1' && tail.startsWith('rpc/')) {
      const name = tail.slice(4);
      this.record('rpc', req, name, ctx);
      result = await this.rpc(name, req, ctx);
    } else if (service === 'rest' && version === 'v1') {
      this.record('rest', req, tail, ctx);
      result = this.rest(tail, req);
    } else if (service === 'functions' && version === 'v1') {
      this.record('functions', req, tail, ctx);
      const handler = this.scenario.functions[tail];
      if (handler) {
        result = await handler(req, ctx);
      } else {
        this.unhandled.push(`function ${request.method()} ${tail}`);
        result = json(404, { error: 'not_found' });
      }
    } else if (service === 'storage' && version === 'v1') {
      this.record('storage', req, tail, ctx);
      result = this.storage(req, tail);
    } else {
      this.unhandled.push(`${request.method()} ${url.pathname}`);
      result = json(404, { error: 'not_found' });
    }

    const headers: Record<string, string> = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-expose-headers': 'content-range, content-type, x-relay-error',
      ...result.headers,
    };
    if (result.json !== undefined) {
      await route.fulfill({ status: result.status ?? 200, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(result.json) });
    } else {
      if (result.contentType) headers['content-type'] = result.contentType;
      await route.fulfill({ status: result.status ?? 200, headers, body: result.body ?? '' });
    }
  }

  private record(kind: Call['kind'], req: FnRequest, name: string, ctx: CallContext): void {
    this.calls.push({ kind, method: req.method, name, url: req.url.toString(), json: req.json, body: req.body, principal: ctx.principal });
  }

  // ---------------------------------------------------------------- auth

  private auth(req: FnRequest, path: string, ctx: CallContext): FnResponse {
    const grant = req.url.searchParams.get('grant_type');
    if (path === 'token' && grant === 'password') {
      const { email, password } = (req.json ?? {}) as { email?: string; password?: string };
      const user = this.scenario.users.find((u) => u.email === email && u.password === password);
      if (!user) return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(200, sessionFor(user, 'aal1'));
    }
    if (path === 'token' && grant === 'refresh_token') {
      const token = (req.json as { refresh_token?: string } | null)?.refresh_token ?? '';
      const user = this.scenario.users.find((u) => token.startsWith(`refresh-${u.id.slice(-4)}`));
      if (!user) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      return json(200, sessionFor(user, token.endsWith('aal2') ? 'aal2' : 'aal1'));
    }
    if (path === 'user' && req.method === 'GET') {
      return ctx.user ? json(200, authUser(ctx.user)) : json(401, { code: 401, msg: 'not signed in' });
    }
    if (path === 'logout') return { status: 204 };
    const factor = path.match(/^factors\/([^/]+)\/(challenge|verify)$/);
    if (factor && ctx.user?.totpFactorId === factor[1]) {
      if (factor[2] === 'challenge') {
        return json(200, { id: 'challenge-1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
      }
      const code = (req.json as { code?: string } | null)?.code;
      if (code !== '123456') return json(422, { code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
      return json(200, sessionFor(ctx.user, 'aal2'));
    }
    this.unhandled.push(`auth ${req.method} ${path}`);
    return json(404, { code: 404, msg: 'not found' });
  }

  // ---------------------------------------------------------------- rest

  private rest(table: string, req: FnRequest): FnResponse {
    const params = req.url.searchParams;
    const rows = this.table(table);
    const prefer = req.headers['prefer'] ?? '';
    const wantsObject = (req.headers['accept'] ?? '').includes('vnd.pgrst.object');
    const returnRows = prefer.includes('return=representation');

    const answer = (out: Row[], status: number, total?: number): FnResponse => {
      const headers: Record<string, string> = {};
      if (/count=(exact|planned|estimated)/.test(prefer)) {
        headers['content-range'] = out.length ? `0-${out.length - 1}/${total ?? out.length}` : `*/${total ?? 0}`;
      }
      if (req.method === 'HEAD') return { status, headers };
      if (wantsObject) {
        if (out.length !== 1) {
          return json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${out.length} rows`, hint: null });
        }
        return json(status, out[0], headers);
      }
      return json(status, out, headers);
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      const all = rows.filter((row) => matches(row, params));
      return answer(project(page(all, params, req.headers['range']), params.get('select')), 200, all.length);
    }
    if (req.method === 'POST') {
      const input = Array.isArray(req.json) ? (req.json as Row[]) : [(req.json ?? {}) as Row];
      const merge = prefer.includes('resolution=merge-duplicates');
      const conflict = (params.get('on_conflict') ?? 'id').split(',');
      const written = input.map((item) => {
        const existing = merge ? rows.find((row) => conflict.every((col) => item[col] !== undefined && row[col] === item[col])) : undefined;
        if (existing) return Object.assign(existing, item);
        const row = { id: this.newId(), created_at: new Date().toISOString(), ...this.scenario.defaults[table], ...item };
        rows.push(row);
        return row;
      });
      return returnRows || wantsObject ? answer(written, 201) : { status: 201 };
    }
    if (req.method === 'PATCH') {
      const hit = rows.filter((row) => matches(row, params));
      for (const row of hit) Object.assign(row, req.json as Row);
      return returnRows || wantsObject ? answer(hit, 200) : { status: 204 };
    }
    if (req.method === 'DELETE') {
      const hit = rows.filter((row) => matches(row, params));
      this.scenario.tables[table] = rows.filter((row) => !hit.includes(row));
      return returnRows || wantsObject ? answer(hit, 200) : { status: 204 };
    }
    return json(405, { message: 'method not allowed' });
  }

  private async rpc(name: string, req: FnRequest, ctx: CallContext): Promise<FnResponse> {
    if (!(name in this.scenario.rpc)) {
      this.unhandled.push(`rpc ${name}`);
      return json(404, { code: 'PGRST202', message: `Could not find the function public.${name}`, details: null, hint: null });
    }
    const handler = this.scenario.rpc[name];
    const args = req.method === 'GET'
      ? Object.fromEntries(req.url.searchParams)
      : ((req.json ?? {}) as Record<string, unknown>);
    const value = typeof handler === 'function' ? await (handler as (a: Record<string, unknown>, c: CallContext) => unknown)(args, ctx) : handler;
    if (value instanceof RpcError) return json(value.status, { code: value.code, message: value.message, details: null, hint: null });
    return json(200, value ?? null);
  }

  // ---------------------------------------------------------------- storage

  private storage(req: FnRequest, path: string): FnResponse {
    const file = (key: string): FnResponse => {
      const bytes = this.scenario.files[key] ?? this.scenario.defaultFile;
      if (!bytes) return json(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return { status: 200, body: bytes, contentType: key.endsWith('.png') ? 'image/png' : 'application/pdf' };
    };
    const signBatch = path.match(/^object\/sign\/([^/]+)$/);
    if (signBatch && req.method === 'POST') {
      const paths = ((req.json as { paths?: string[] } | null)?.paths ?? []);
      return json(200, paths.map((p) => ({ path: p, signedURL: `/object/sign/${signBatch[1]}/${p}?token=mock`, error: null })));
    }
    const sign = path.match(/^object\/sign\/(.+)$/);
    if (sign && req.method === 'POST') return json(200, { signedURL: `/object/sign/${sign[1]}?token=mock` });
    if (sign && req.method === 'GET') return file(decodeURIComponent(sign[1]));
    const read = path.match(/^object\/(?:authenticated|public)\/(.+)$/);
    if (read && req.method === 'GET') return file(decodeURIComponent(read[1]));
    if (path.startsWith('object/list/')) return json(200, []);
    const object = path.match(/^object\/(.+)$/);
    if (object && (req.method === 'POST' || req.method === 'PUT')) {
      return json(200, { Key: object[1], Id: this.newId() });
    }
    if (object && req.method === 'DELETE') return json(200, []);
    if (path.startsWith('object') && req.method === 'DELETE') return json(200, []);
    this.unhandled.push(`storage ${req.method} ${path}`);
    return json(404, { statusCode: '404', error: 'not_found', message: 'not found' });
  }

  // ---------------------------------------------------------------- realtime

  /**
   * Accepts the socket and answers every join and heartbeat with "ok", echoing the channel's
   * postgres_changes bindings so the client is satisfied. No change is ever pushed.
   */
  private realtime(ws: WebSocketRoute): void {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      const isArray = Array.isArray(parsed);
      const [joinRef, ref, topic, event, payload] = isArray
        ? (parsed as [string | null, string | null, string, string, Record<string, unknown>])
        : (() => {
            const m = parsed as { join_ref?: string; ref?: string; topic: string; event: string; payload: Record<string, unknown> };
            return [m.join_ref ?? null, m.ref ?? null, m.topic, m.event, m.payload] as const;
          })();
      if (event !== 'phx_join' && event !== 'heartbeat' && event !== 'access_token' && event !== 'phx_leave') return;
      let response: Record<string, unknown> = {};
      if (event === 'phx_join') {
        const bindings = ((payload?.config as { postgres_changes?: Record<string, unknown>[] } | undefined)?.postgres_changes ?? []);
        response = { postgres_changes: bindings.map((b, i) => ({ ...b, id: i + 1 })) };
      }
      const reply = { status: 'ok', response };
      ws.send(JSON.stringify(isArray ? [joinRef, ref, topic, 'phx_reply', reply] : { join_ref: joinRef, ref, topic, event: 'phx_reply', payload: reply }));
    });
  }
}
