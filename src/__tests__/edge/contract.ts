/**
 * The edge contract: what every edge function must do at its door, as one call a
 * function's test makes. A function built on createHandler passes it by construction;
 * this proves the wiring (the right auth modes, the body cap, generic errors) per
 * function, and catches a handler that bypasses createHandler.
 *
 *   describeEdgeContract({
 *     name: 'delete-contact',
 *     handler: createDeleteContactHandler(deps()),
 *     failingHandler: createDeleteContactHandler(deps({ begin: throwInternal })),
 *     credentials: CREDENTIALS.owner,
 *     wrongPrincipal: CREDENTIALS.client,
 *     body: { kind: 'json', valid: { contact_id: CONTACT }, maxBytes: 1024 },
 *   });
 *
 * Wire the function's auth with fakeOwnerAuth() / fakeClientAuth() and the secrets below,
 * so the credentials here mean the same thing in every test.
 */
import { describe, expect, it } from 'vitest';
import type { AuthOutcome, ClientPrincipal, OwnerPrincipal } from '../../../supabase/functions/_shared/auth';
import { REFUSALS } from '../../../supabase/functions/_shared/handler';
import { SECURITY_HEADERS } from '../../../supabase/functions/_shared/http';
import { CRON_SECRET_HEADER } from '../../../supabase/functions/_shared/secrets';

export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const REFUSED_ORIGIN = 'https://elsewhere.example';

export const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
export const CLIENT_USER_ID = '00000000-0000-4000-8000-0000000000c1';
export const CLIENT_CONTACT_ID = '10000000-0000-4000-8000-0000000000c1';
export const CLIENT_SESSION_ID = '20000000-0000-4000-8000-0000000000c1';

export const OWNER_TOKEN = 'contract-owner-token';
export const CLIENT_TOKEN = 'contract-client-token';
export const VIEW_AS_CLIENT_TOKEN = 'contract-view-as-client-token';
export const CRON_SECRET = 'c'.repeat(64);
export const INTERNAL_HEADER = 'x-internal-secret';
export const INTERNAL_SECRET = 'i'.repeat(64);

/** What a failing dependency throws in `failingHandler`. It must never reach a response. */
export const INTERNAL_ERROR_MARKER = 'contract-internal-detail-0451';
export const throwInternal = async (): Promise<never> => {
  throw new Error(INTERNAL_ERROR_MARKER);
};

export const CREDENTIALS = {
  owner: { Authorization: `Bearer ${OWNER_TOKEN}` },
  client: { Authorization: `Bearer ${CLIENT_TOKEN}` },
  viewAsClient: { Authorization: `Bearer ${VIEW_AS_CLIENT_TOKEN}` },
  cron: { [CRON_SECRET_HEADER]: CRON_SECRET },
  internal: { [INTERNAL_HEADER]: INTERNAL_SECRET },
} as const;

const CLIENT_TOKENS = [CLIENT_TOKEN, VIEW_AS_CLIENT_TOKEN];

/** authorizeOwner with the real outcome shape: the owner token passes, a client token is 403, anything else 401. */
export function fakeOwnerAuth(): (token: string) => Promise<AuthOutcome<OwnerPrincipal>> {
  return async (token) => {
    if (token === OWNER_TOKEN) return { ok: true, principal: { kind: 'owner', userId: OWNER_ID } };
    return { ok: false, status: CLIENT_TOKENS.includes(token) ? 403 : 401 };
  };
}

/** authorizeClient likewise: the client token passes, the View-as-client token passes impersonating, the owner token is 403. */
export function fakeClientAuth(): (token: string) => Promise<AuthOutcome<ClientPrincipal>> {
  return async (token) => {
    if (CLIENT_TOKENS.includes(token)) {
      return {
        ok: true,
        principal: {
          kind: 'client',
          userId: CLIENT_USER_ID,
          contactId: CLIENT_CONTACT_ID,
          sessionId: CLIENT_SESSION_ID,
          impersonating: token === VIEW_AS_CLIENT_TOKEN,
        },
      };
    }
    return { ok: false, status: token === OWNER_TOKEN ? 403 : 401 };
  };
}

export interface EdgeRequestInit {
  method?: string;
  /** Default ALLOWED_ORIGIN; null sends no Origin (a server-to-server call). */
  origin?: string | null;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a string or bytes as-is. */
  body?: unknown;
  /** Overrides Content-Length after the body is set (to send a lying one). */
  contentLength?: string;
}

export function edgeRequest(init: EdgeRequestInit = {}): Request {
  const method = init.method ?? 'POST';
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? ALLOWED_ORIGIN);
  let body: BodyInit | undefined;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && init.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof Uint8Array) body = new Uint8Array(init.body);
    else {
      body = JSON.stringify(init.body);
      headers.set('Content-Type', 'application/json');
    }
  }
  const req = new Request('http://edge.test/fn', { method, headers, body });
  if (init.contentLength !== undefined) req.headers.set('Content-Length', init.contentLength);
  return req;
}

/** The headers every response carries, errors included. */
export function expectEdgeHeaders(res: Response, origin: string | null = ALLOWED_ORIGIN): void {
  expect(res.headers.get('Vary') ?? '').toMatch(/(^|,\s*)Origin(\s*,|$)/);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) expect([key, res.headers.get(key)]).toEqual([key, value]);
  if (origin === ALLOWED_ORIGIN) expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  else expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
}

async function expectRefusal(res: Response, refusal: { status: number; error: string; code: string }): Promise<void> {
  expect(res.status).toBe(refusal.status);
  expect(await res.json()).toEqual({ error: refusal.error, code: refusal.code });
}

export type ContractBody =
  | { kind: 'json'; valid: unknown; maxBytes: number }
  | { kind: 'bytes'; valid: Uint8Array; maxBytes: number }
  | { kind: 'optional_json' | 'none' };

export interface EdgeContractTarget {
  name: string;
  /** The function wired with fakes: fakeOwnerAuth / fakeClientAuth and the secrets above. */
  handler: (req: Request) => Promise<Response>;
  /** The same function with one dependency that throws INTERNAL_ERROR_MARKER (see throwInternal). */
  failingHandler: (req: Request) => Promise<Response>;
  /** Headers that authenticate; null for a public function. */
  credentials: Record<string, string> | null;
  /** A live session of a principal this function refuses (403). */
  wrongPrincipal?: Record<string, string>;
  /** The function refuses View as client (clientWrites). */
  clientWrites?: boolean;
  /** A public function: the same function with its limiter answering 'limited'. */
  limitedHandler?: (req: Request) => Promise<Response>;
  body: ContractBody;
  /** Default 'POST'. */
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
}

/** Every credential header swapped for a wrong value of the same shape. */
function invalidVariants(credentials: Record<string, string>): Record<string, string>[] {
  return Object.keys(credentials).map((key) => ({
    ...credentials,
    [key]: key.toLowerCase() === 'authorization' ? 'Bearer not-a-live-session' : 'w'.repeat(64),
  }));
}

export function describeEdgeContract(t: EdgeContractTarget): void {
  const method = t.method ?? 'POST';
  const otherMethod = method === 'PUT' ? 'PATCH' : 'PUT';
  const validBody = t.body.kind === 'json' || t.body.kind === 'bytes' ? t.body.valid : undefined;
  const call = (init: EdgeRequestInit, handler = t.handler) => handler(edgeRequest({ method, body: validBody, ...init }));

  describe(`${t.name}: edge contract`, () => {
    it('answers a preflight from the allowed origin with a CORS grant', async () => {
      const res = await call({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': method } });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe('authorization, x-client-info, apikey, content-type');
      expect(res.headers.get('Access-Control-Allow-Methods')?.split(', ')).toContain(method);
      expectEdgeHeaders(res);
    });

    it('refuses a preflight from another origin, with no CORS grant', async () => {
      const res = await call({ method: 'OPTIONS', origin: REFUSED_ORIGIN });
      expect(res.status).toBe(403);
      expectEdgeHeaders(res, REFUSED_ORIGIN);
    });

    it('refuses a request from another origin even with valid credentials', async () => {
      const res = await call({ origin: REFUSED_ORIGIN, headers: t.credentials ?? {} });
      expectEdgeHeaders(res, REFUSED_ORIGIN);
      await expectRefusal(res, REFUSALS.originNotAllowed);
    });

    it('refuses another method with 405 and an Allow header', async () => {
      const res = await call({ method: otherMethod, headers: t.credentials ?? {} });
      expectEdgeHeaders(res);
      expect(res.headers.get('Allow')?.split(', ')).toContain(method);
      await expectRefusal(res, REFUSALS.methodNotAllowed);
    });

    if (t.credentials) {
      const credentials = t.credentials;
      it('refuses a request with no credential with a generic 401', async () => {
        const res = await call({});
        expectEdgeHeaders(res);
        await expectRefusal(res, REFUSALS.unauthenticated);
      });

      it('refuses an invalid credential with a generic 401', async () => {
        for (const headers of invalidVariants(credentials)) {
          const res = await call({ headers });
          expectEdgeHeaders(res);
          await expectRefusal(res, REFUSALS.unauthenticated);
        }
      });
    }

    if (t.wrongPrincipal) {
      const wrong = t.wrongPrincipal;
      it('refuses a live session of the wrong kind with 403', async () => {
        const res = await call({ headers: wrong });
        expectEdgeHeaders(res);
        await expectRefusal(res, REFUSALS.forbidden);
      });
    }

    if (t.clientWrites) {
      it('refuses a View-as-client session as read-only', async () => {
        const res = await call({ headers: CREDENTIALS.viewAsClient });
        expectEdgeHeaders(res);
        await expectRefusal(res, REFUSALS.readOnly);
      });
    }

    if (t.limitedHandler) {
      const limited = t.limitedHandler;
      it('checks the rate limit before reading the body', async () => {
        const res = await call({ headers: t.credentials ?? {}, body: '{not json' }, limited);
        expectEdgeHeaders(res);
        await expectRefusal(res, REFUSALS.rateLimited);
      });
    }

    if (t.body.kind === 'json' || t.body.kind === 'bytes') {
      const cap = t.body.maxBytes;
      it('refuses a body over the cap with 413, whatever Content-Length claims', async () => {
        const over = 'x'.repeat(cap + 1);
        for (const init of [{ body: over }, { body: over, contentLength: '2' }]) {
          const res = await call({ headers: t.credentials ?? {}, ...init });
          expectEdgeHeaders(res);
          await expectRefusal(res, REFUSALS.tooLarge);
        }
      });
    }

    if (t.body.kind === 'json') {
      it('refuses malformed JSON with 400', async () => {
        const res = await call({ headers: t.credentials ?? {}, body: '{not json' });
        expectEdgeHeaders(res);
        await expectRefusal(res, REFUSALS.badRequest);
      });
    }

    it('answers an internal error with a generic 500 that leaks nothing', async () => {
      const res = await call({ headers: t.credentials ?? {} }, t.failingHandler);
      expect(res.status).toBe(500);
      expectEdgeHeaders(res);
      const text = await res.text();
      expect(text).not.toContain(INTERNAL_ERROR_MARKER);
      expect(text).not.toMatch(/\bat\s+\S+\s+\(|stack/i);
      expect(typeof (JSON.parse(text) as { error?: unknown }).error).toBe('string');
    });

    it('lets a valid request through the door, with the same headers', async () => {
      const res = await call({ headers: t.credentials ?? {} });
      expect([400, 401, 403, 405, 413, 429]).not.toContain(res.status);
      expectEdgeHeaders(res);
    });
  });
}
