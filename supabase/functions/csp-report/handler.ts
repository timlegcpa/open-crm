// csp-report: where browsers send Content-Security-Policy violation reports, so the owner
// can see what a policy blocked (csp_violation_reports, read by SQL). No session: the
// browser posts on its own.
//
// It is inert until the site's host sends a CSP response header naming it
//   Content-Security-Policy: ...; report-uri <SUPABASE_URL>/functions/v1/csp-report; report-to csp-endpoint
//   Reporting-Endpoints: csp-endpoint="<SUPABASE_URL>/functions/v1/csp-report"
// (a <meta> CSP cannot report), and it drops every report until SITE_URL names the site.
//
// A reporting endpoint must not tell a caller which gate stopped it, so every outcome is
// the same bodiless 204, except a body over the cap (413, which a browser never sends).
// Behind that uniform answer the shared door still runs in full: method, origin, the
// per-address limit, then the shared ceiling, both before the body is read, in one call
// (the shared checkPublicLimits, over check_public_rate_limit) that records nothing
// unless both allow. The rules:
//   - An Origin on the list is required. Browsers send one with every report (the
//     report content types force a preflight); a script that leaves it out is dropped.
//     Origin is trivially forged, so the limits are what bound a flood, not this.
//   - Per address 20 requests in 10 minutes, then 100 requests an hour across everyone,
//     and at most 5 rows a request: so at most ROW_CEILING_PER_HOUR (500) stored reports
//     an hour, one site's real reports, not an abuse ceiling sized for a big platform.
//     Per address first: run the other way round, one address could spend the shared
//     ceiling for every visitor. An unparseable address is bucketed under one shared
//     sentinel, never exempted.
//   - A limiter that errors, or throws, drops the report: a limiter that cannot answer
//     is not limiting.
//   - Only well-formed reports become rows: a Reporting API entry of type csp-violation
//     with a body object, or a legacy report, either naming a directive (effective or
//     violated) and a URL (document or blocked). A body of `[{},{},...]` stores nothing.
//   - A row keeps only the normalized fields, each cut to FIELD_BYTES (the table's CHECKs
//     say the same), never a copy of the report: anyone can post here, so the most a
//     flood can store is bounded (under 2 KB a row, 500 rows an hour, kept 30 days).
//   - A failed insert is logged (by its code, never its values) and still answers 204.

import { createHandler } from '../_shared/handler.ts';
import { responseHeaders } from '../_shared/http.ts';
import { createLogger, type LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';

export const MAX_BODY_BYTES = 16_384;
export const MAX_ROWS_PER_REQUEST = 5;
/** Requests, not rows: the limiter runs before the body is read. */
export const PER_IP_LIMIT = { max: 20, windowMinutes: 10 } as const;
export const GLOBAL_LIMIT = { max: 100, windowMinutes: 60 } as const;
/** What index.ts passes to the shared checkPublicLimits, with the caller's address and agent. */
export const CSP_LIMITS = { action: 'csp_report', perIp: PER_IP_LIMIT, global: GLOBAL_LIMIT } as const;
/** The most reports stored in an hour, across everyone: shared requests times rows each. */
export const ROW_CEILING_PER_HOUR = GLOBAL_LIMIT.max * MAX_ROWS_PER_REQUEST;

/** Each text column's cap in UTF-8 bytes; 0001_core.sql checks the same numbers. */
export const FIELD_BYTES = {
  document_url: 400,
  referrer: 300,
  violated_directive: 64,
  effective_directive: 64,
  blocked_url: 400,
  source_file: 400,
  disposition: 16,
  user_agent: 200,
  ip_address: 45,
} as const;

export interface CspReportRow {
  document_url: string | null;
  referrer: string | null;
  violated_directive: string | null;
  effective_directive: string | null;
  blocked_url: string | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  disposition: string | null;
  status_code: number | null;
  user_agent: string | null;
  ip_address: string | null;
}

export interface CspReportDeps {
  allowedOrigins: string[];
  /** checkPublicLimits (_shared/rate-limit.ts) with CSP_LIMITS, on the service client. */
  limits(ip: string | null, userAgent: string | null): Promise<RateLimitOutcome>;
  insert(rows: CspReportRow[]): Promise<{ error: unknown }>;
  logSink?: LogSink;
}

type Obj = Record<string, unknown>;

function pickStr(o: Obj | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === 'string' ? v : null;
}

function pickInt(o: Obj | undefined, k: string): number | null {
  const v = o?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The legacy report-uri shape: { "csp-report": { "document-uri": ..., ... } }. */
export function normalizeLegacy(body: Obj, ua: string | null, ip: string | null): CspReportRow {
  const r = isObj(body['csp-report']) ? body['csp-report'] : {};
  return {
    document_url: pickStr(r, 'document-uri'),
    referrer: pickStr(r, 'referrer'),
    violated_directive: pickStr(r, 'violated-directive'),
    effective_directive: pickStr(r, 'effective-directive'),
    blocked_url: pickStr(r, 'blocked-uri'),
    source_file: pickStr(r, 'source-file'),
    line_number: pickInt(r, 'line-number'),
    column_number: pickInt(r, 'column-number'),
    disposition: pickStr(r, 'disposition'),
    status_code: pickInt(r, 'status-code'),
    user_agent: ua,
    ip_address: ip,
  };
}

/** One Reporting API entry: { type: 'csp-violation', url, user_agent, body: { documentURL, ... } }. */
export function normalizeReportingApi(entry: Obj, ip: string | null): CspReportRow {
  const b = isObj(entry.body) ? entry.body : {};
  return {
    document_url: pickStr(b, 'documentURL') ?? pickStr(entry, 'url'),
    referrer: pickStr(b, 'referrer'),
    violated_directive: pickStr(b, 'effectiveDirective') ?? pickStr(b, 'violatedDirective'),
    effective_directive: pickStr(b, 'effectiveDirective'),
    blocked_url: pickStr(b, 'blockedURL'),
    source_file: pickStr(b, 'sourceFile'),
    line_number: pickInt(b, 'lineNumber'),
    column_number: pickInt(b, 'columnNumber'),
    disposition: pickStr(b, 'disposition'),
    status_code: pickInt(b, 'statusCode'),
    user_agent: pickStr(entry, 'user_agent'),
    ip_address: ip,
  };
}

const present = (s: string | null): boolean => s !== null && s !== '';

/** A report worth a row: it names a directive and a URL (the table's CHECK says the same). */
export function wellFormed(row: CspReportRow): boolean {
  return (present(row.violated_directive) || present(row.effective_directive)) &&
    (present(row.document_url) || present(row.blocked_url));
}

/** `s` cut to at most `max` UTF-8 bytes, never inside a character. */
export function cutBytes(s: string | null, max: number): string | null {
  if (s === null) return null;
  const encoder = new TextEncoder();
  if (encoder.encode(s).byteLength <= max) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = encoder.encode(ch).byteLength;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/** Every text field cut to its cap. */
export function bounded(row: CspReportRow): CspReportRow {
  const out = { ...row };
  for (const [key, max] of Object.entries(FIELD_BYTES) as Array<[keyof typeof FIELD_BYTES, number]>) {
    out[key] = cutBytes(row[key], max);
  }
  return out;
}

/** The rows a parsed body becomes: well-formed reports only, each bounded, at most MAX_ROWS_PER_REQUEST. */
export function reportRows(parsed: unknown, ua: string | null, ip: string | null): CspReportRow[] {
  if (Array.isArray(parsed)) {
    return parsed
      .filter((entry): entry is Obj => isObj(entry) && entry.type === 'csp-violation' && isObj(entry.body))
      .map((entry) => bounded(normalizeReportingApi(entry, ip)))
      .filter(wellFormed)
      .slice(0, MAX_ROWS_PER_REQUEST);
  }
  if (isObj(parsed) && isObj(parsed['csp-report'])) return [bounded(normalizeLegacy(parsed, ua, ip))].filter(wellFormed);
  return [];
}

export function createCspReportHandler(deps: CspReportDeps): (req: Request) => Promise<Response> {
  const door = createHandler({
    name: 'csp-report',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: ({ ip, userAgent }) => deps.limits(ip, userAgent),
    body: 'bytes',
    maxBodyBytes: MAX_BODY_BYTES,
    logSink: deps.logSink,
    async handle({ body, ip, userAgent, log }) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return new Response(null, { status: 204 });
      }
      const rows = reportRows(parsed, userAgent, ip);
      if (rows.length > 0) {
        const { error } = await deps.insert(rows);
        if (error) log.error('insert failed', error, { rows: rows.length });
      }
      return new Response(null, { status: 204 });
    },
  });

  if (deps.allowedOrigins.length === 0) {
    // Once per cold start: in production with SITE_URL unset, every report is dropped.
    createLogger('csp-report', { sink: deps.logSink }).warn('no allowed origin is configured (set SITE_URL); every report is dropped');
  }

  /** The same bodiless 204 for every outcome but an oversized body. */
  const drop = (req: Request): Response => {
    const headers = responseHeaders(req, deps.allowedOrigins);
    delete headers['Content-Type'];
    return new Response(null, { status: 204, headers });
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'OPTIONS' && !req.headers.get('Origin')) return drop(req);
    const res = await door(req);
    if (res.status === 204 || res.status === 413) return res;
    await res.body?.cancel().catch(() => {});
    return drop(req);
  };
}
