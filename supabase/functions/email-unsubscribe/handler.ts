// email-unsubscribe: the opt-out door for group email. Public by necessity: the person
// clicking holds an email, not a session. The capability is the token, which names one
// address and can do one thing, suppress it.
//
// The rules that shape this file:
//   1. GET NEVER UNSUBSCRIBES. Mail clients, link scanners and security gateways prefetch
//      every URL in a message; a GET that acted would opt out people who never clicked.
//      GET asks (email_unsubscribe_lookup); only POST writes (email_unsubscribe_confirm).
//   2. Idempotent, and it never says whether an address is known: malformed and unknown
//      tokens read the same ('invalid'), a second click reads 'unsubscribed'.
//   3. A token never expires for opting out (see email_unsubscribe_tokens.expires_at).
//   4. THE LIMITS, IN ORDER. One rate-limit call decides each request, chosen by what
//      the query token turns out to be, and nothing reads the body before it decides:
//        a. The query token's shape is checked, and a well-formed one is looked up: one
//           indexed read by a unique hash, which writes nothing. That is why the lookup
//           may run before any limit: refusing at this step costs nobody a row.
//        b. ONE check_public_rate_limit call, which records nothing unless both of its
//           buckets allow (two calls in turn once committed the address row even when the
//           shared ceiling then refused, so every fresh address still wrote a row after
//           the ceiling was spent):
//             known token: the token's own action, per method (scanners only GET and must
//               not spend the POST allowance), with the per-address limit and the token's
//               own limit as the shared bucket. No one else's traffic can touch it, so a
//               junk flood cannot close a real token's door.
//             junk (no query token, a malformed or an unknown one): 'email_unsubscribe.junk'
//               with the per-address limit and the shared junk ceiling, which no known
//               token ever spends.
//           The per-address bucket is per address within that action. It is generous
//           (sized for a mail provider's pooled egress: RFC 8058 one-click POSTs and
//           gateway prefetches come from a few shared addresses carrying every recipient
//           of every sender), so it bounds one abuser without refusing a provider.
//        c. Only then is a body read, and only for a POST with no query token, after the
//           junk call allowed it. A known body token then spends its own call as in b.
//      Any limiter (or the lookup) that cannot answer is 503, never a pass; the token is
//      not consumed, so that costs nobody their opt-out.
//   5. The token is read from the query (a click, RFC 8058 one-click) or, for a POST
//      without one, from a urlencoded body capped at 4 KiB while it streams.
//
// Two audiences. The /unsubscribe page asks for JSON and branches on `state`. Anything
// else is a mail client: a GET is sent to that page (the default Supabase domain serves
// hosted HTML as plain text, so the page is the human door), and a POST is RFC 8058
// one-click, whose body providers ignore.
//
// Every response, refusals and preflights included, carries the security headers plus
// X-Robots-Tag: a link holding a token must never be indexed.

import { sha256Hex } from '../_shared/crypto.ts';
import { createHandler, REFUSALS } from '../_shared/handler.ts';
import { BodyError, readBodyBytes } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { checkPublicLimits, type Limit, type RateLimitClient, type RateLimitOutcome } from '../_shared/rate-limit.ts';

export type UnsubscribeKind = 'view' | 'confirm';
export type LookupState = 'invalid' | 'confirm' | 'unsubscribed';
export type ConfirmState = 'invalid' | 'unsubscribed';

export interface UnsubscribeDeps {
  allowedOrigins: string[];
  /** EdgeConfig.siteUrl: where the human page lives. */
  siteUrl: string | null;
  /** Rule 4b, a known token: ONE call, the per-address limit then the token's own, for this kind of request. */
  checkTokenLimit(kind: UnsubscribeKind, tokenHash: string, ip: string | null, userAgent: string | null): Promise<RateLimitOutcome>;
  /** Rule 4b, junk: ONE call, the per-address limit then the ceiling every junk request shares. */
  checkJunkLimit(ip: string | null, userAgent: string | null): Promise<RateLimitOutcome>;
  /** email_unsubscribe_lookup. Throws on error. */
  lookup(tokenHash: string): Promise<LookupState>;
  /** email_unsubscribe_confirm. Throws on error. */
  confirm(tokenHash: string): Promise<ConfirmState>;
  logSink?: LogSink;
}

/** The production limits (rule 4), here so the tests run the same numbers. */
export const UNSUBSCRIBE_LIMITS = {
  perIp: { max: 300, windowMinutes: 60 },
  perToken: { max: 10, windowMinutes: 60 },
  junk: { max: 2000, windowMinutes: 60 },
} as const;

/** The action every junk request shares (check_public_rate_limit adds .ip and .global). */
export const JUNK_ACTION = 'email_unsubscribe.junk';

/** One token's action: keyed by a prefix of its hash, never the token. */
export const tokenAction = (kind: UnsubscribeKind, tokenHash: string) =>
  `email_unsubscribe_${kind}.token:${tokenHash.slice(0, 32)}`;

/**
 * The two calls of rule 4b against the real limiter, each ONE check_public_rate_limit
 * transaction. Per address: sized for a mail provider's pooled egress, not for one person.
 * Per token: a person opens a link a few times; a token minted for one address has no
 * reason to be used more. Junk: far above any real volume of mistyped links, and never
 * spent by a real token. Tests pass lower limits to fit.
 */
export function unsubscribeLimits(
  db: RateLimitClient,
  limits: { perIp: Limit; perToken: Limit; junk: Limit } = UNSUBSCRIBE_LIMITS,
): Pick<UnsubscribeDeps, 'checkTokenLimit' | 'checkJunkLimit'> {
  return {
    checkTokenLimit: (kind, tokenHash, ip, userAgent) =>
      checkPublicLimits(db, { action: tokenAction(kind, tokenHash), ip, userAgent, perIp: limits.perIp, global: limits.perToken }),
    checkJunkLimit: (ip, userAgent) =>
      checkPublicLimits(db, { action: JUNK_ACTION, ip, userAgent, perIp: limits.perIp, global: limits.junk }),
  };
}

/** The only form field is a token of at most 200 characters. */
export const MAX_FORM_BYTES = 4096;
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;

/** How a token is stored: the same shared hash the send used when it minted the token. */
export const hashToken = (token: string): Promise<string> => sha256Hex(token);

const wantsJson = (req: Request) => (req.headers.get('Accept') ?? '').includes('application/json');

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });

const queryToken = (req: Request) => new URL(req.url).searchParams.get('t');

/** The token from the query, else (POST only) from a bounded urlencoded body. Null when there is none. */
async function readToken(req: Request): Promise<string | null> {
  const fromQuery = queryToken(req);
  if (fromQuery) return fromQuery;
  if (req.method !== 'POST') return null;
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBytes(req, MAX_FORM_BYTES);
  } catch (err) {
    if (err instanceof BodyError) return null;
    throw err;
  }
  // URLSearchParams, never formData(): one-click carries `List-Unsubscribe=One-Click`
  // and the page sends no body at all, so neither is ever multipart.
  return new URLSearchParams(new TextDecoder().decode(bytes)).get('t');
}

const kindOf = (req: Request): UnsubscribeKind => (req.method === 'POST' ? 'confirm' : 'view');

type Found = { hash: string; state: LookupState };

/** A well-formed token, looked up (a read, never a write). Null when it is not a known token. */
async function lookUp(deps: UnsubscribeDeps, token: string | null): Promise<Found | null> {
  if (!token || !TOKEN.test(token)) return null;
  const hash = await hashToken(token);
  const state = await deps.lookup(hash);
  return state === 'invalid' ? null : { hash, state };
}

export function createUnsubscribeHandler(deps: UnsubscribeDeps): (req: Request) => Promise<Response> {
  // What rule 4a found for each request, handed from the limit to handle.
  const found = new WeakMap<Request, Found | null>();

  const handler = createHandler({
    name: 'email-unsubscribe',
    allowedOrigins: deps.allowedOrigins,
    methods: ['GET', 'POST'],
    auth: { public: true },
    body: 'none',
    logSink: deps.logSink,
    // Rule 4a and 4b: the read-only lookup, then the one call its outcome picks. A lookup
    // that throws lands here too, and the shared handler answers it 503.
    rateLimit: async ({ req, ip, userAgent }) => {
      const hit = await lookUp(deps, queryToken(req));
      found.set(req, hit);
      return hit ? deps.checkTokenLimit(kindOf(req), hit.hash, ip, userAgent) : deps.checkJunkLimit(ip, userAgent);
    },
    async handle({ req, ip, userAgent, json }) {
      const asJson = wantsJson(req);
      const refused = (outcome: RateLimitOutcome) => {
        const r = outcome === 'limited' ? REFUSALS.rateLimited : REFUSALS.unavailable;
        return json(r.status, { error: r.error, code: r.code });
      };
      const invalid = () => (asJson ? json(410, { state: 'invalid' }) : text(410, 'This unsubscribe link could not be read.'));

      let token = queryToken(req);
      let hit = found.get(req) ?? null;
      if (!hit) {
        // Junk, and the junk call allowed it. Rule 4c: only a POST with no query token
        // may carry the token in a body, and a known one spends its own call.
        if (token || req.method !== 'POST') return invalid();
        token = await readToken(req);
        hit = await lookUp(deps, token);
        if (!hit) return invalid();
        const perToken = await deps.checkTokenLimit(kindOf(req), hit.hash, ip, userAgent);
        if (perToken !== 'allowed') return refused(perToken);
      }

      if (req.method === 'GET') {
        if (!asJson) {
          // A mail client opened the link: send it to the page, which only asks. The token
          // passed the shape check; the host is configuration, never input.
          if (!deps.siteUrl) return text(200, 'Open the unsubscribe link in your email from a web browser.');
          const page = `${deps.siteUrl.replace(/\/+$/, '')}/unsubscribe?t=${encodeURIComponent(token!)}`;
          return text(303, '', { Location: page });
        }
        return json(200, { state: hit.state });
      }

      const done = await deps.confirm(hit.hash);
      if (asJson) return json(done === 'invalid' ? 410 : 200, { state: done });
      return done === 'invalid' ? text(410, 'This unsubscribe link could not be read.') : text(200, 'Unsubscribed.');
    },
  });

  return async (req) => {
    const res = await handler(req);
    const headers = new Headers(res.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
