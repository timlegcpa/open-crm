// @vitest-environment node
// csp-report. It is the written exception to describeEdgeContract: a reporting endpoint
// answers every refusal with the same bodiless 204 (contract.ts asserts a 403 for a
// refused origin, a 401 or 429 elsewhere), so the door is proven here instead: the 204
// set, the limiter before the body, 413 only for an oversized body. The limits and the
// insert run against the real migrations in PGlite.
import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/harness';
import { serviceClient } from './pgliteClient';
import { ALLOWED_ORIGIN, REFUSED_ORIGIN, edgeRequest, type EdgeRequestInit } from './contract';
import {
  createCspReportHandler,
  CSP_LIMITS,
  GLOBAL_LIMIT,
  ROW_CEILING_PER_HOUR,
  wellFormed,
  MAX_BODY_BYTES,
  MAX_ROWS_PER_REQUEST,
  PER_IP_LIMIT,
  reportRows,
  bounded,
  cutBytes,
  FIELD_BYTES,
  type CspReportDeps,
  type CspReportRow,
} from '../../../supabase/functions/csp-report/handler';
import { SECURITY_HEADERS } from '../../../supabase/functions/_shared/http';
import { checkPublicLimits, type RateLimitClient } from '../../../supabase/functions/_shared/rate-limit';

/** What index.ts wires: the shared limiter with the endpoint's limits. */
const cspLimits = (client: RateLimitClient, ip: string | null, userAgent: string | null) =>
  checkPublicLimits(client, { ...CSP_LIMITS, ip, userAgent });

let db: PGlite;

async function insertRows(rows: CspReportRow[]): Promise<{ error: unknown }> {
  try {
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      for (const r of rows) {
        await tx.query(
          `INSERT INTO public.csp_violation_reports (document_url, referrer, violated_directive, effective_directive,
             blocked_url, source_file, line_number, column_number, disposition, status_code, user_agent, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [r.document_url, r.referrer, r.violated_directive, r.effective_directive, r.blocked_url, r.source_file,
            r.line_number, r.column_number, r.disposition, r.status_code, r.user_agent, r.ip_address],
        );
      }
    });
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

function deps(over: Partial<CspReportDeps> = {}): CspReportDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    allowedOrigins: [ALLOWED_ORIGIN],
    limits: (ip, userAgent) => cspLimits(serviceClient(db), ip, userAgent),
    insert: insertRows,
    logSink: (_level, line) => logs.push(line),
    ...over,
  };
}

const LEGACY = {
  'csp-report': {
    'document-uri': 'https://crm.example.com/contacts',
    referrer: '',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://cdn.example.net/x.js',
    'source-file': 'https://crm.example.com/assets/app.js',
    'line-number': 12,
    'column-number': 7.9,
    disposition: 'enforce',
    'status-code': 200,
  },
};

const ENTRY = (n = 0) => ({
  type: 'csp-violation',
  url: 'https://crm.example.com/',
  user_agent: 'Example Browser',
  body: {
    documentURL: `https://crm.example.com/page-${n}`,
    effectiveDirective: 'img-src',
    blockedURL: 'https://img.example.net/a.png',
    sourceFile: null,
    lineNumber: 3,
    columnNumber: 1,
    disposition: 'report',
    statusCode: 200,
  },
});

const post = (init: EdgeRequestInit = {}) =>
  edgeRequest({ headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Example Browser' }, ...init });

async function stored(): Promise<Array<Record<string, unknown>>> {
  return (await db.query<Record<string, unknown>>('SELECT * FROM public.csp_violation_reports ORDER BY id')).rows;
}

async function expectDropped(res: Response, origin: string | null = ALLOWED_ORIGIN): Promise<void> {
  expect(res.status).toBe(204);
  expect(res.body).toBeNull();
  expect(await res.text()).toBe('');
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) expect([key, res.headers.get(key)]).toEqual([key, value]);
  expect(res.headers.get('Vary')).toContain('Origin');
  if (origin !== ALLOWED_ORIGIN) expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
}

beforeAll(async () => {
  db = await createDb();
}, 60_000);

beforeEach(async () => {
  await db.exec('DELETE FROM public.csp_violation_reports; DELETE FROM public.auth_rate_limits;');
});

describe('csp-report: storing reports', () => {
  it('stores a legacy report, normalized, with the address and browser', async () => {
    const res = await createCspReportHandler(deps())(post({ body: LEGACY }));
    await expectDropped(res);
    const [row] = await stored();
    expect(row).toMatchObject({
      document_url: 'https://crm.example.com/contacts',
      violated_directive: 'script-src-elem',
      blocked_url: 'https://cdn.example.net/x.js',
      line_number: 12,
      column_number: 7,
      disposition: 'enforce',
      status_code: 200,
      user_agent: 'Example Browser',
      ip_address: '203.0.113.9',
    });
    expect(row).not.toHaveProperty('raw');
  });

  it('stores Reporting API entries of type csp-violation, and nothing else from the array', async () => {
    const body = [ENTRY(1), { type: 'deprecation', body: { id: 'x' } }, {}, 'junk', null, ENTRY(2)];
    await expectDropped(await createCspReportHandler(deps())(post({ body })));
    const rows = await stored();
    expect(rows.map((r) => r.document_url)).toEqual(['https://crm.example.com/page-1', 'https://crm.example.com/page-2']);
    expect(rows[0]).toMatchObject({ violated_directive: 'img-src', effective_directive: 'img-src', user_agent: 'Example Browser' });
  });

  it(`keeps at most ${MAX_ROWS_PER_REQUEST} rows from one request`, async () => {
    const body = Array.from({ length: 60 }, (_, i) => ({ type: 'csp-violation', body: { documentURL: `u${i}`, effectiveDirective: 'img-src' } }));
    await createCspReportHandler(deps())(post({ body }));
    expect(await stored()).toHaveLength(MAX_ROWS_PER_REQUEST);
  });

  it('a failed insert is logged by its code, never its values, and still answers 204', async () => {
    const d = deps({ insert: async () => ({ error: { code: '23514', message: 'new row violates: "ada@example.com"' } }) });
    await expectDropped(await createCspReportHandler(d)(post({ body: LEGACY })));
    expect(d.logs.join('\n')).toContain('23514');
    expect(d.logs.join('\n')).not.toContain('ada@example.com');
  });

  it('warns once at start when no origin is allowed (SITE_URL unset in production)', () => {
    const d = deps({ allowedOrigins: [] });
    createCspReportHandler(d);
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toContain('SITE_URL');
    expect(deps().logs).toHaveLength(0);
  });
});

describe('csp-report: every refusal is the same bodiless 204', () => {
  const cases: Array<[string, CspReportDeps, EdgeRequestInit]> = [
    ['an origin not on the list', deps(), { origin: REFUSED_ORIGIN, body: LEGACY }],
    ['no origin at all', deps(), { origin: null, body: LEGACY }],
    ['a GET', deps(), { method: 'GET' }],
    ['the limit reached', deps({ limits: async () => 'limited' }), { body: LEGACY }],
    ['a limiter that cannot answer', deps({ limits: async () => 'unavailable' }), { body: LEGACY }],
    ['a limiter that throws', deps({ limits: async () => { throw new Error('down'); } }), { body: LEGACY }],
    ['malformed JSON', deps(), { body: '{"csp-report": ' }],
    ['an empty body', deps(), { body: '' }],
    ['a body with no report in it', deps(), { body: { hello: 'world' } }],
    ['an array with no csp-violation entry', deps(), { body: [{ type: 'intervention', body: {} }] }],
    ['an entry whose body is not an object', deps(), { body: [{ type: 'csp-violation', url: 'https://crm.example.com/', body: 'x' }] }],
    ['an entry with no body', deps(), { body: [{ type: 'csp-violation', url: 'https://crm.example.com/' }] }],
    ['an entry with an empty body', deps(), { body: [{ type: 'csp-violation', url: 'https://crm.example.com/', body: {} }] }],
    ['an entry with no directive', deps(), { body: [{ type: 'csp-violation', body: { documentURL: 'https://crm.example.com/' } }] }],
    ['an entry with no URL', deps(), { body: [{ type: 'csp-violation', body: { effectiveDirective: 'img-src' } }] }],
    ['an empty legacy report', deps(), { body: { 'csp-report': {} } }],
    ['a legacy report with empty strings', deps(), { body: { 'csp-report': { 'document-uri': '', 'violated-directive': '' } } }],
  ];

  it.each(cases)('%s', async (_what, d, init) => {
    const inserts: number[] = [];
    const watched: CspReportDeps = { ...d, insert: async (rows) => { inserts.push(rows.length); return d.insert(rows); } };
    const res = await createCspReportHandler(watched)(post(init));
    await expectDropped(res, init.origin === undefined ? ALLOWED_ORIGIN : init.origin);
    // Not even attempted: the table's CHECK refusing a row is the backstop, not the rule.
    expect(inserts).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('checks the limits before reading the body', async () => {
    let read = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        read = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(LEGACY)));
        controller.close();
      },
    }, { highWaterMark: 0 }); // pulled only when something reads it
    const req = new Request('http://edge.test/fn', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expectDropped(await createCspReportHandler(deps({ limits: async () => 'limited' }))(req));
    expect(read).toBe(false);
  });

  it('answers 413 only for a body over the cap, whatever Content-Length claims', async () => {
    const over = 'x'.repeat(MAX_BODY_BYTES + 1);
    for (const init of [{ body: over }, { body: over, contentLength: '2' }]) {
      const res = await createCspReportHandler(deps())(post(init));
      expect(res.status).toBe(413);
    }
    const atCap = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES - 20) }).slice(0, MAX_BODY_BYTES);
    expect((await createCspReportHandler(deps())(post({ body: atCap }))).status).toBe(204);
  });

  it('grants CORS to a preflight from the allowed origin, and nothing to another', async () => {
    const ok = await createCspReportHandler(deps())(post({ method: 'OPTIONS' }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('content-type');
    const refused = await createCspReportHandler(deps())(post({ method: 'OPTIONS', origin: REFUSED_ORIGIN }));
    await expectDropped(refused, REFUSED_ORIGIN);
  });
});

describe('csp-report: the limits', () => {
  it('once the shared ceiling is spent, fresh addresses store nothing and record nothing', async () => {
    await db.query(
      `INSERT INTO public.auth_rate_limits (action) SELECT 'csp_report.global' FROM generate_series(1, $1)`,
      [GLOBAL_LIMIT.max],
    );
    const handler = createCspReportHandler(deps());
    for (let i = 1; i <= 5; i++) await handler(post({ body: LEGACY, headers: { 'cf-connecting-ip': `198.51.100.${i}` } }));
    expect(await stored()).toEqual([]);
    const [{ n }] = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'csp_report.ip'`,
    )).rows;
    expect(n).toBe(0);
  });

  it('reads the limiter fail-closed', async () => {
    const answering = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({ rpc: answer });
    const outcome = (answer: () => Promise<{ data: unknown; error: unknown }>) => cspLimits(answering(answer), null, null);
    expect(await outcome(async () => ({ data: 1, error: null }))).toBe('allowed');
    expect(await outcome(async () => ({ data: null, error: null }))).toBe('limited');
    expect(await outcome(async () => ({ data: null, error: { code: 'XX000' } }))).toBe('unavailable');
    expect(await outcome(async () => { throw new Error('down'); })).toBe('unavailable');
    expect(await outcome(async () => ({ data: 0, error: null }))).toBe('unavailable');
    expect(await outcome(async () => ({ data: '1', error: null }))).toBe('unavailable');
    let args: Record<string, unknown> | undefined;
    await cspLimits({ rpc: async (_fn, a) => { args = a; return { data: 1, error: null }; } }, '203.0.113.9', 'x'.repeat(600));
    expect(args).toMatchObject({ p_action: 'csp_report', p_ip: '203.0.113.9', p_ip_max: PER_IP_LIMIT.max, p_global_max: GLOBAL_LIMIT.max });
    expect(String(args?.p_user_agent)).toHaveLength(512);
  });

  it(`one address gets ${PER_IP_LIMIT.max} reports in ten minutes, and spends nothing of the shared ceiling past that`, async () => {
    const handler = createCspReportHandler(deps());
    for (let i = 0; i < PER_IP_LIMIT.max + 5; i++) await handler(post({ body: LEGACY }));
    expect(await stored()).toHaveLength(PER_IP_LIMIT.max);
    const buckets = (await db.query<{ action: string; n: number }>(
      'SELECT action, count(*)::int AS n FROM public.auth_rate_limits GROUP BY action ORDER BY action',
    )).rows;
    expect(buckets).toEqual([
      { action: 'csp_report.global', n: PER_IP_LIMIT.max },
      { action: 'csp_report.ip', n: PER_IP_LIMIT.max },
    ]);
  });

  it('an address it cannot read shares one bucket instead of going unlimited', async () => {
    const handler = createCspReportHandler(deps());
    for (let i = 0; i < PER_IP_LIMIT.max + 3; i++) {
      await handler(edgeRequest({ headers: { 'x-forwarded-for': `not-an-ip-${i}` }, body: LEGACY }));
    }
    expect(await stored()).toHaveLength(PER_IP_LIMIT.max);
  });
});

describe('csp-report: what one row can cost', () => {
  const huge = (ch: string) => ch.repeat(5000);
  const worst = (ch: string): CspReportRow => ({
    document_url: huge(ch), referrer: huge(ch), violated_directive: huge(ch), effective_directive: huge(ch),
    blocked_url: huge(ch), source_file: huge(ch), line_number: 2 ** 31 - 1, column_number: 2 ** 31 - 1,
    disposition: huge(ch), status_code: 2 ** 31 - 1, user_agent: huge(ch),
    ip_address: 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255',
  });

  it.each([['ASCII', 'x'], ['two-byte', 'é'], ['four-byte', '\u{1F600}']])(
    'a row with every field at its cap (%s) stays under 2 KB',
    async (_what, ch) => {
      expect((await insertRows([bounded(worst(ch))])).error).toBeNull();
      const [{ bytes }] = (await db.query<{ bytes: number }>('SELECT pg_column_size(t.*) AS bytes FROM public.csp_violation_reports t')).rows;
      expect(bytes).toBeLessThanOrEqual(2048);
    },
  );

  it('the table refuses a field over its cap, whatever the function does', async () => {
    for (const [field, max] of Object.entries(FIELD_BYTES)) {
      const row = { ...bounded(worst('x')), [field]: 'x'.repeat(max + 1) } as CspReportRow;
      const { error } = await insertRows([row]);
      expect([field, String((error as Error | null)?.message)]).toEqual([field, expect.stringMatching(/check constraint/)]);
    }
  });

  it('cuts a long field from a real report, never inside a character', async () => {
    const body = { 'csp-report': { ...LEGACY['csp-report'], 'document-uri': `https://crm.example.com/${'é'.repeat(3000)}` } };
    await createCspReportHandler(deps())(post({ body }));
    const [row] = await stored();
    const url = String(row.document_url);
    expect(new TextEncoder().encode(url).byteLength).toBeLessThanOrEqual(FIELD_BYTES.document_url);
    expect(url).not.toContain('�');
    expect(url.startsWith('https://crm.example.com/é')).toBe(true);
    expect(cutBytes('aé', 2)).toBe('a');
    expect(cutBytes(null, 2)).toBeNull();
  });

  it.each([
    ['a Reporting API entry', [{ type: 'csp-violation', url: 'x'.repeat(600), user_agent: 'x'.repeat(600), body: {
      documentURL: 'x'.repeat(600), referrer: 'x'.repeat(600), effectiveDirective: 'x'.repeat(600), blockedURL: 'x'.repeat(600),
      sourceFile: 'x'.repeat(600), disposition: 'x'.repeat(600) } }]],
    ['a legacy report', { 'csp-report': {
      'document-uri': 'x'.repeat(600), referrer: 'x'.repeat(600), 'violated-directive': 'x'.repeat(600),
      'effective-directive': 'x'.repeat(600), 'blocked-uri': 'x'.repeat(600), 'source-file': 'x'.repeat(600),
      disposition: 'x'.repeat(600) } }],
  ])('%s with every field oversized is stored, each field cut to its cap', async (_what, body) => {
    await createCspReportHandler(deps())(post({ body, headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'x'.repeat(600) } }));
    const rows = await stored();
    expect(rows).toHaveLength(1);
    for (const [field, max] of Object.entries(FIELD_BYTES)) {
      if (field !== 'ip_address') expect([field, String(rows[0][field]).length]).toEqual([field, max]);
    }
  });

  it('the hourly ceiling counts rows: shared requests times rows a request, 500 at most', () => {
    expect(GLOBAL_LIMIT.windowMinutes).toBe(60);
    expect(ROW_CEILING_PER_HOUR).toBe(GLOBAL_LIMIT.max * MAX_ROWS_PER_REQUEST);
    expect(ROW_CEILING_PER_HOUR).toBeLessThanOrEqual(500);
    // Under 2 KB a row: at most about 1 MB of reports an hour, about 0.7 GB over 30 days
    // only if the ceiling is hit every hour of the month.
    expect(ROW_CEILING_PER_HOUR * 2048).toBeLessThanOrEqual(1_048_576);
    // One address cannot spend the whole shared ceiling in one window.
    expect(PER_IP_LIMIT.max).toBeLessThan(GLOBAL_LIMIT.max);
  });

  it('the last shared request stores at most its rows, and past the ceiling nothing is stored', async () => {
    await db.query(
      `INSERT INTO public.auth_rate_limits (action) SELECT 'csp_report.global' FROM generate_series(1, $1)`,
      [GLOBAL_LIMIT.max - 1],
    );
    const batch = Array.from({ length: 60 }, (_, i) => ({ type: 'csp-violation', body: { documentURL: `u${i}`, effectiveDirective: 'img-src' } }));
    const handler = createCspReportHandler(deps());
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await handler(post({ body: batch, headers: { 'cf-connecting-ip': ip } }));
    }
    expect(await stored()).toHaveLength(MAX_ROWS_PER_REQUEST);
  });
});

describe('reportRows', () => {
  it('reads nothing from a legacy body without a report object', () => {
    expect(reportRows({ 'csp-report': 'x' }, null, null)).toEqual([]);
    expect(reportRows(42, null, null)).toEqual([]);
  });

  it('a row is well formed only with a directive and a URL', () => {
    const row = bounded({ ...reportRows(LEGACY, null, null)[0] });
    expect(wellFormed(row)).toBe(true);
    expect(wellFormed({ ...row, violated_directive: null, effective_directive: '' })).toBe(false);
    expect(wellFormed({ ...row, document_url: '', blocked_url: null })).toBe(false);
    expect(wellFormed({ ...row, violated_directive: null, document_url: null })).toBe(true);
  });
});

describe('client addresses written by edge functions', () => {
  // The address columns are inet (audit_logs, client_activity_log, auth_rate_limits): a
  // value Postgres refuses fails the whole insert. Every function writes the address it
  // got from getClientIp (ctx.ip), a real literal or null, never a raw header or a
  // placeholder like 'unknown'.
  it('every ip_address an edge function writes is the handler context ip', () => {
    const root = 'supabase/functions';
    const offenders: string[] = [];
    for (const dir of readdirSync(root).filter((d) => !d.startsWith('_') && statSync(path.join(root, d)).isDirectory())) {
      for (const file of readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(path.join(root, dir, file), 'utf8');
        for (const m of text.matchAll(/\bip_address\s*:\s*([^,\n}]+)/g)) {
          const value = m[1].trim();
          // A bare number is a length cap (FIELD_BYTES), not a value written.
          // `<flag> ? ip : null` records the context ip only for some callers (documents
          // keeps the client's own address and never the owner's).
          if (!/^(ip|ctx\.ip|string \| null;?|\d+|[A-Za-z_][\w.]* \? (ip|ctx\.ip) : null)$/.test(value)) offenders.push(`${dir}/${file}: ip_address: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
