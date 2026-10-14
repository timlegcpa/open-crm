// @vitest-environment node
// The caller address and the rate-limit wrappers. The wrappers run against the real
// 0001 functions in PGlite through named arguments, so a wrong parameter name fails
// here, not in production; the fail-closed paths use fakes that error or answer oddly.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/harness';
import {
  checkGlobalLimit,
  checkIpLimit,
  checkPublicLimits,
  checkUserLimit,
  getClientIp,
  isIpLiteral,
  type RateLimitClient,
} from '../../../supabase/functions/_shared/rate-limit';
import { serviceClient } from './pgliteClient';

const reqWith = (headers: Record<string, string>) => new Request('http://edge.test/fn', { headers });

describe('getClientIp: precedence', () => {
  it('prefers cf-connecting-ip over a client-supplied x-forwarded-for', () => {
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'cf-connecting-ip': '203.0.113.7' });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to the first x-forwarded-for hop, then x-real-ip, then null', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))).toBe('198.51.100.9');
    expect(getClientIp(reqWith({ 'x-real-ip': '192.0.2.44' }))).toBe('192.0.2.44');
    expect(getClientIp(reqWith({}))).toBeNull();
  });

  it('skips a value that is not an IP and uses the next real one', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': 'not-an-ip', 'x-real-ip': '192.0.2.44' }))).toBe('192.0.2.44');
    expect(getClientIp(reqWith({ 'x-forwarded-for': '  203.0.113.7  , 10.0.0.1' }))).toBe('203.0.113.7');
  });
});

const ACCEPT = [
  '203.0.113.7',
  '0.0.0.0',
  '::1',
  '::',
  '2001:db8::1',
  '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  'fe80::1',
  '::ffff:192.168.1.1',
  '2001:db8::192.168.1.1',
];
const REJECT = [
  'host.example.test',
  '10.0.0.0/8',
  '999.1.1.1',
  '10.0.1',
  '203.0.113.7:8080',
  'unknown',
  '',
  '01.2.3.4',
  '::ffff:01.2.3.4',
  '::::',
  '1::2::3',
  // Two `::` whose groups add up to eight: only the one-`::` rule refuses it.
  '1:2:3::4:5:6::7:8',
  '2001:db8:::1',
  'gggg::1',
  '12345::1',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8:9',
  '2001:db8::1%eth0',
  '::ffff:999.1.1.1',
  '1.2.3.4::',
  ':::',
];

describe('isIpLiteral', () => {
  it.each(ACCEPT)('accepts %s', (value) => expect(isIpLiteral(value)).toBe(true));
  it.each(REJECT)('rejects %s', (value) => expect(isIpLiteral(value)).toBe(false));
});

let db: PGlite;
let client: RateLimitClient;
const USER = '00000000-0000-4000-8000-0000000000e1';

beforeAll(async () => {
  db = await createDb();
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${USER}', 'user@example.test')`);
  client = serviceClient(db);
}, 60_000);

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}

describe('isIpLiteral accepts only what Postgres inet accepts', () => {
  it('every accepted value casts to inet', async () => {
    for (const value of ACCEPT) {
      const [row] = await rows(`SELECT $1::inet::text AS v`, [value]);
      expect([value, typeof row.v]).toEqual([value, 'string']);
    }
  });
});

describe('the buckets, against 0001', () => {
  it('checkIpLimit allows up to the max, then limits that address only', async () => {
    const limit = { action: 'test.ip_a', max: 2, windowMinutes: 5 };
    expect(await checkIpLimit(client, { ...limit, ip: '203.0.113.1' })).toBe('allowed');
    expect(await checkIpLimit(client, { ...limit, ip: '203.0.113.1', userAgent: 'agent' })).toBe('allowed');
    expect(await checkIpLimit(client, { ...limit, ip: '203.0.113.1' })).toBe('limited');
    expect(await checkIpLimit(client, { ...limit, ip: '203.0.113.2' })).toBe('allowed');
  });

  it('puts every missing address in one shared bucket instead of exempting it', async () => {
    const limit = { action: 'test.ip_none', max: 1, windowMinutes: 5 };
    expect(await checkIpLimit(client, { ...limit, ip: null })).toBe('allowed');
    expect(await checkIpLimit(client, { ...limit, ip: null })).toBe('limited');
  });

  it('checkGlobalLimit and checkUserLimit count their own buckets', async () => {
    const g = { action: 'test.global', max: 1, windowMinutes: 5 };
    expect(await checkGlobalLimit(client, g)).toBe('allowed');
    expect(await checkGlobalLimit(client, g)).toBe('limited');
    const u = { action: 'test.user', userId: USER, max: 1, windowMinutes: 5 };
    expect(await checkUserLimit(client, u)).toBe('allowed');
    expect(await checkUserLimit(client, u)).toBe('limited');
  });

  it('a non-positive limit is an error in the database, so the wrapper refuses', async () => {
    expect(await checkGlobalLimit(client, { action: 'test.zero', max: 0, windowMinutes: 5 })).toBe('unavailable');
  });

  it('checkPublicLimits: a refused address never spends the shared bucket', async () => {
    const opts = { action: 'test.public', perIp: { max: 1, windowMinutes: 5 }, global: { max: 3, windowMinutes: 5 } };
    expect(await checkPublicLimits(client, { ...opts, ip: '198.51.100.1' })).toBe('allowed');
    for (let i = 0; i < 5; i++) expect(await checkPublicLimits(client, { ...opts, ip: '198.51.100.1' })).toBe('limited');
    const [global] = await rows(`SELECT count(*)::int AS n FROM public.auth_rate_limits WHERE action = 'test.public.global'`);
    expect(global.n).toBe(1);
    expect(await checkPublicLimits(client, { ...opts, ip: '198.51.100.2' })).toBe('allowed');
    expect(await checkPublicLimits(client, { ...opts, ip: '198.51.100.3' })).toBe('allowed');
    expect(await checkPublicLimits(client, { ...opts, ip: '198.51.100.4' })).toBe('limited');
  });
});

describe('the wrappers fail closed', () => {
  const answering = (result: { data: unknown; error: unknown }): RateLimitClient => ({ rpc: async () => result });
  const limit = { action: 'test.closed', max: 5, windowMinutes: 5 };

  it('an RPC error or a throw is unavailable, never allowed', async () => {
    expect(await checkGlobalLimit(answering({ data: 1, error: { code: '57014' } }), limit)).toBe('unavailable');
    const throwing: RateLimitClient = { rpc: () => { throw new Error('network'); } };
    expect(await checkGlobalLimit(throwing, limit)).toBe('unavailable');
  });

  it('only a positive integer count is allowed; null is limited; anything else is unavailable', async () => {
    expect(await checkGlobalLimit(answering({ data: 3, error: null }), limit)).toBe('allowed');
    expect(await checkGlobalLimit(answering({ data: null, error: null }), limit)).toBe('limited');
    for (const data of [0, -1, 1.5, '1', true, undefined, {}]) {
      expect([data, await checkGlobalLimit(answering({ data, error: null }), limit)]).toEqual([data, 'unavailable']);
    }
  });

  it('checkPublicLimits stops at an unavailable address bucket', async () => {
    const calls: string[] = [];
    const db2: RateLimitClient = {
      rpc: async (fn) => {
        calls.push(fn);
        return { data: null, error: { code: 'XX000' } };
      },
    };
    const opts = { action: 'test.stop', ip: '192.0.2.1', perIp: limit, global: limit };
    expect(await checkPublicLimits(db2, opts)).toBe('unavailable');
    expect(calls).toEqual(['check_auth_ip_rate_limit']);
  });
});
