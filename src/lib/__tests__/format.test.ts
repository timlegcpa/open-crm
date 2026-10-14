import { afterAll, describe, expect, it, vi } from 'vitest';

// West of Greenwich, where reading a 'YYYY-MM-DD' day as UTC midnight shows the previous
// day. Set before format.ts builds its formatters; restored for the next file in this worker.
const previousTz = vi.hoisted(() => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  return tz;
});

import {
  NO_VALUE_TEXT,
  formatAccounting,
  formatCurrency,
  formatCurrencyShort,
  formatDate,
  formatDateLong,
  formatDateShort,
  formatDateTime,
  formatFileSize,
  formatMonthYear,
  formatPhoneNumber,
  formatRelativeTime,
  parseDateOnly,
  splitFilename,
  toISODate,
  wholeDaysBetween,
} from '@/lib/format';

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe('money', () => {
  it('formats currency, with the no-value glyph for nothing', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
    expect(formatCurrency(-3)).toBe('-$3.00');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrencyShort(1234.5)).toBe('$1,235');
    expect(formatCurrency(null)).toBe(NO_VALUE_TEXT);
    expect(formatCurrency(Number.NaN)).toBe(NO_VALUE_TEXT);
  });

  it('formats accounting style: parentheses for a negative, a dash for zero', () => {
    expect(formatAccounting(1234.5)).toBe('1,234.50');
    expect(formatAccounting(-500, { prefix: '$ ' })).toBe('($ 500.00)');
    expect(formatAccounting(0)).toBe('-');
    expect(formatAccounting(0, { dashForZero: false })).toBe('0.00');
    expect(formatAccounting(null)).toBe('-');
  });
});

describe('dates', () => {
  it('reads a date-only value as that calendar day, not the day before', () => {
    expect(formatDate('2026-04-07')).toBe('Apr 7, 2026');
    expect(formatDateShort('2026-04-07')).toBe('Apr 7');
    expect(formatDateLong('2026-04-07')).toBe('April 7, 2026');
    expect(formatMonthYear('2026-07')).toBe('July 2026');
  });

  it('shows an instant in the local zone', () => {
    expect(formatDateTime('2026-04-07T22:45:00Z')).toBe('Apr 7, 2026, 3:45 PM');
  });

  it('gives the no-value glyph for nothing or nonsense', () => {
    expect(formatDate(null)).toBe(NO_VALUE_TEXT);
    expect(formatDate('')).toBe(NO_VALUE_TEXT);
    expect(formatDate('not a date')).toBe(NO_VALUE_TEXT);
  });

  it('turns a Date into its LOCAL calendar day', () => {
    // 11:30 pm in Los Angeles is already the next day in UTC.
    expect(toISODate(new Date(2026, 3, 7, 23, 30))).toBe('2026-04-07');
  });

  it('parses a date-only value or a month key as a local date, and refuses days that do not exist', () => {
    expect(parseDateOnly('2026-04-07')).toEqual(new Date(2026, 3, 7));
    expect(parseDateOnly('2026-04')).toEqual(new Date(2026, 3, 1));
    expect(parseDateOnly('2026-02-31')).toBeNull();
    expect(parseDateOnly('2026-13')).toBeNull();
    expect(parseDateOnly('07/04/2026')).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
  });

  it('counts calendar days, not 24-hour spans', () => {
    expect(wholeDaysBetween(new Date(2026, 3, 6, 23, 0), new Date(2026, 3, 7, 1, 0))).toBe(1);
    expect(wholeDaysBetween('2026-04-01', new Date(2026, 3, 7, 12, 0))).toBe(6);
  });

  it('says how long ago, then falls back to the date', () => {
    const now = new Date(2026, 3, 7, 12, 0);
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(formatRelativeTime(ago(10_000), now)).toBe('just now');
    expect(formatRelativeTime(ago(5 * 60_000), now)).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatRelativeTime(new Date(2026, 3, 6, 23, 0), now)).toBe('yesterday');
    expect(formatRelativeTime(new Date(2026, 3, 3, 12, 0), now)).toBe('4 days ago');
    expect(formatRelativeTime(new Date(2026, 2, 20, 12, 0), now)).toBe('Mar 20, 2026');
    expect(formatRelativeTime(new Date(now.getTime() + 5 * 60_000), now)).toBe('in 5 minutes');
    expect(formatRelativeTime(null, now)).toBe(NO_VALUE_TEXT);
  });
});

describe('other helpers', () => {
  it('formats a ten-digit phone number and leaves anything else alone', () => {
    expect(formatPhoneNumber('5550100001')).toBe('(555) 010-0001');
    expect(formatPhoneNumber('+44 20 7946 0000')).toBe('+44 20 7946 0000');
    expect(formatPhoneNumber(null)).toBe('');
  });

  it('formats file sizes and splits file names', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(splitFilename('report.final.pdf')).toEqual({ name: 'report.final', ext: '.pdf' });
    expect(splitFilename('.env')).toEqual({ name: '.env', ext: '' });
  });
});
