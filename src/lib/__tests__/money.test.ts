// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMoneyAmount } from '@/lib/money';

describe('parseMoneyAmount', () => {
  it('reads plain digits, comma groups of three and up to two decimals, with an optional $', () => {
    expect(parseMoneyAmount('50000')).toBe(50000);
    expect(parseMoneyAmount(' $50,000.50 ')).toBe(50000.5);
    expect(parseMoneyAmount('$ 12,345,678.9')).toBe(12345678.9);
    expect(parseMoneyAmount('1250.05')).toBe(1250.05);
  });

  it('refuses anything it would otherwise misread', () => {
    for (const bad of ['', ' ', '-50', '50k', '1,2,3', '12,34', '1,2345', '1.234', '.5', '$', '$$5', '5$', 'oops0', '1 000', '+5', '1e3', 'Infinity']) {
      expect([bad, parseMoneyAmount(bad, { allowZero: true })]).toEqual([bad, null]);
    }
  });

  it('is positive unless zero is allowed', () => {
    expect(parseMoneyAmount('0')).toBeNull();
    expect(parseMoneyAmount('$0.00')).toBeNull();
    expect(parseMoneyAmount('0', { allowZero: true })).toBe(0);
    expect(parseMoneyAmount('0.01')).toBe(0.01);
  });
});
