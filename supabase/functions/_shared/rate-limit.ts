// The caller's network address and the rate-limit buckets in 0001_core.sql
// (check_auth_ip_rate_limit, check_auth_global_rate_limit, check_auth_user_rate_limit,
// and check_public_rate_limit, which runs the first two as one transaction).
//
// Every wrapper fails closed. A limiter that logs its own error and lets the request
// through is not a limiter: an unreadable bucket table would remove every bound on a
// public endpoint at exactly the moment the database is already unhealthy. So an RPC
// error, or any answer that is not a positive count, is 'unavailable', which the
// handler refuses with 503 ("I could not check"), as opposed to 'limited', 429 ("you
// sent too many").

import { createLogger } from './log.ts';

export type RateLimitOutcome = 'allowed' | 'limited' | 'unavailable';

/** True only for a bare IPv4 or IPv6 literal: no CIDR suffix, no hostname, no port. */
export function isIpLiteral(value: string): boolean {
  if (!value || value.length > 45 || value.includes('/')) return false;
  return value.includes(':') ? isIpv6Literal(value) : isIpv4Literal(value);
}

/**
 * A dotted quad with NO leading zero on any octet. Postgres accepts '01.2.3.4'::inet but
 * rejects '::ffff:01.2.3.4'::inet, so a permissive octet check once passed a value that
 * failed the cast downstream. Refusing leading zeros everywhere keeps what this accepts a
 * strict subset of what inet takes; a real client address never carries them.
 */
function isIpv4Literal(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255);
}

/**
 * A real IPv6 shape check, not a character class: at most one `::`, one to four hex
 * digits per group, an optional trailing dotted quad (the ::ffff:1.2.3.4 form) counting
 * as two groups, exactly eight groups without `::` and fewer with it. Zone ids (%eth0)
 * are refused; inet does not take them.
 */
function isIpv6Literal(value: string): boolean {
  if (value.includes('%')) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  let count = 0;
  for (let h = 0; h < halves.length; h++) {
    const half = halves[h];
    if (half === '') continue;
    const groups = half.split(':');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const isLast = h === halves.length - 1 && i === groups.length - 1;
      if (isLast && g.includes('.')) {
        if (!isIpv4Literal(g)) return false;
        count += 2;
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return false;
      count += 1;
    }
  }
  return compressed ? count < 8 : count === 8;
}

/**
 * The calling client's address, or null when no header carries a real IP literal.
 *
 * Order: cf-connecting-ip, then the first x-forwarded-for hop, then x-real-ip, taking the
 * first that is an IP literal. The order is security-bearing. x-forwarded-for is
 * client-settable: a caller who sends `X-Forwarded-For: 1.2.3.4` has it echoed as the
 * first hop, so reading it first lets a caller pick its own rate-limit bucket by
 * rotating one header. cf-connecting-ip is written by the Cloudflare edge in front of
 * Supabase and a client cannot forge it, so it goes first.
 *
 * The shape check is the other half: a malformed value is skipped rather than passed on,
 * so a real address further down the chain is used instead. A null result is safe to
 * pass to the IP limiter, which buckets every unusable address under one shared
 * sentinel rather than exempting it. Also the right value for the inet columns
 * (audit_logs.ip_address, client_activity_log.ip_address), where null inserts fine.
 */
export function getClientIp(req: Request): string | null {
  const candidates = [
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-forwarded-for')?.split(',')[0],
    req.headers.get('x-real-ip'),
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value && isIpLiteral(value)) return value;
  }
  return null;
}

/** The slice of a Supabase client the limiter calls. supabase-js clients satisfy it. */
export interface RateLimitClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface Limit {
  max: number;
  windowMinutes: number;
}

const log = createLogger('rate-limit');

async function bucket(db: RateLimitClient, fn: string, args: Record<string, unknown>): Promise<RateLimitOutcome> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await db.rpc(fn, args));
  } catch (err) {
    error = err;
  }
  if (error) {
    log.error(`${fn} failed; refusing`, error, { action: String(args.p_action) });
    return 'unavailable';
  }
  if (data === null) return 'limited';
  // Each function returns the new count. Anything else is not an answer.
  return Number.isInteger(data) && (data as number) >= 1 ? 'allowed' : 'unavailable';
}

/** One address's bucket. `ip` may be null (see getClientIp). */
export function checkIpLimit(
  db: RateLimitClient,
  opts: { action: string; ip: string | null; userAgent?: string | null } & Limit,
): Promise<RateLimitOutcome> {
  return bucket(db, 'check_auth_ip_rate_limit', {
    p_action: opts.action,
    p_ip: opts.ip,
    p_max_count: opts.max,
    p_window_minutes: opts.windowMinutes,
    p_user_agent: opts.userAgent ? opts.userAgent.slice(0, 512) : null,
  });
}

/** The bucket every caller of one action shares. */
export function checkGlobalLimit(db: RateLimitClient, opts: { action: string } & Limit): Promise<RateLimitOutcome> {
  return bucket(db, 'check_auth_global_rate_limit', {
    p_action: opts.action,
    p_max_count: opts.max,
    p_window_minutes: opts.windowMinutes,
  });
}

/** One verified user's bucket. The function refuses a null user id rather than allowing it. */
export function checkUserLimit(
  db: RateLimitClient,
  opts: { action: string; userId: string } & Limit,
): Promise<RateLimitOutcome> {
  return bucket(db, 'check_auth_user_rate_limit', {
    p_action: opts.action,
    p_user_id: opts.userId,
    p_max_count: opts.max,
    p_window_minutes: opts.windowMinutes,
  });
}

/**
 * The pair every public endpoint carries, in ONE database call (check_public_rate_limit):
 * the caller's address bucket (`<action>.ip`), then the shared ceiling (`<action>.global`).
 * The function appends the two suffixes itself, so `action` is the bare name.
 *
 * Per address decides first: run the other way round, one address could spend the shared
 * bucket for every visitor (fifty junk requests commit fifty shared rows, three survive
 * the per-address check, and the endpoint is closed to everyone for the window). And
 * nothing is recorded unless BOTH allow. Two calls in turn committed the address row even
 * when the shared ceiling then refused, so once the ceiling was spent every fresh address
 * still wrote a row; one transaction leaves none. Same fail-closed reading as the
 * single buckets: an error, a throw, or any answer but a positive count is 'unavailable';
 * NULL (either limit reached) is 'limited'.
 */
export function checkPublicLimits(
  db: RateLimitClient,
  opts: { action: string; ip: string | null; userAgent?: string | null; perIp: Limit; global: Limit },
): Promise<RateLimitOutcome> {
  return bucket(db, 'check_public_rate_limit', {
    p_action: opts.action,
    p_ip: opts.ip,
    p_ip_max: opts.perIp.max,
    p_ip_window_minutes: opts.perIp.windowMinutes,
    p_global_max: opts.global.max,
    p_global_window_minutes: opts.global.windowMinutes,
    p_user_agent: opts.userAgent ? opts.userAgent.slice(0, 512) : null,
  });
}
