// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CRON_SECRET_HEADER,
  MIN_SECRET_LENGTH,
  secretMatches,
  timingSafeEqual,
  verifyCronSecret,
  verifyInternalSecret,
} from '../../../supabase/functions/_shared/secrets';

const SECRET = 's'.repeat(64);
const reqWith = (headers: Record<string, string>) => new Request('http://edge.test/fn', { method: 'POST', headers });

describe('timingSafeEqual', () => {
  it('is true only for identical strings, including multi-byte ones', () => {
    expect(timingSafeEqual(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqual('café', 'café')).toBe(true);
    expect(timingSafeEqual(SECRET, `${'s'.repeat(63)}t`)).toBe(false);
    expect(timingSafeEqual(SECRET, SECRET.slice(1))).toBe(false);
    expect(timingSafeEqual('', SECRET)).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('secretMatches: fails closed on the configured side', () => {
  it('refuses when the configured secret is unset, empty or shorter than the floor', () => {
    const short = 's'.repeat(MIN_SECRET_LENGTH - 1);
    for (const configured of [undefined, null, '', short]) {
      expect([configured, secretMatches(configured ?? 'anything', configured)]).toEqual([configured, false]);
    }
  });

  it('refuses a missing or wrong presented value and accepts the right one', () => {
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches('w'.repeat(64), SECRET)).toBe(false);
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches('s'.repeat(MIN_SECRET_LENGTH), 's'.repeat(MIN_SECRET_LENGTH))).toBe(true);
  });
});

describe('verifyCronSecret / verifyInternalSecret', () => {
  it('read their own header, case-insensitively, and nothing else', () => {
    expect(CRON_SECRET_HEADER).toBe('x-cron-secret');
    expect(verifyCronSecret(reqWith({ 'X-Cron-Secret': SECRET }), SECRET)).toBe(true);
    expect(verifyCronSecret(reqWith({ Authorization: `Bearer ${SECRET}` }), SECRET)).toBe(false);
    expect(verifyInternalSecret(reqWith({ 'x-internal-secret': SECRET }), 'x-internal-secret', SECRET)).toBe(true);
    expect(verifyInternalSecret(reqWith({ 'x-cron-secret': SECRET }), 'x-internal-secret', SECRET)).toBe(false);
    expect(verifyInternalSecret(reqWith({ 'x-internal-secret': SECRET }), 'x-internal-secret', undefined)).toBe(false);
  });
});
