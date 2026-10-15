/**
 * Month arithmetic on 'YYYY-MM' keys, the grain every marketing figure groups by.
 *
 * Deliberately not `new Date()` arithmetic: a Date built from a month string parses as UTC
 * and can land in the previous month once it is read back in a zone west of Greenwich. A
 * month is an index from year zero here, so one modulo handles both directions and the
 * December wrap is written once.
 */

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True for a well-formed 'YYYY-MM'. */
export const isMonthKey = (value: string): boolean => MONTH_KEY.test(value);

const index = (yyyyMM: string): number => Number(yyyyMM.slice(0, 4)) * 12 + Number(yyyyMM.slice(5, 7)) - 1;
const fromIndex = (idx: number): string => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;

/** `yyyyMM` shifted by `n` whole months, negative to go back. A malformed month comes back untouched. */
export function addMonths(yyyyMM: string, n: number): string {
  const [y, m] = yyyyMM.split('-').map(Number);
  if (!y || !m) return yyyyMM;
  return fromIndex(y * 12 + (m - 1) + n);
}

/**
 * Whole months from `fromMonth` up to and including `toMonth`. 0 when the end is before the
 * start (the goal builder refuses that), or when either is malformed.
 */
export function monthsBetween(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return 0;
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

/** The `n` months ending at `toYm`, oldest first. */
export function monthsEnding(toYm: string, n: number): string[] {
  const end = index(toYm);
  return Array.from({ length: n }, (_, i) => fromIndex(end - (n - 1) + i));
}

/**
 * Months from `fromMonth` through `toMonth`, newest first, capped at `max`. The cap is what
 * stops a mistyped year from producing a row (or a write) for every month to 2999.
 */
export function monthsNewestFirst(fromMonth: string, toMonth: string, max: number): string[] {
  const span = Math.min(monthsBetween(fromMonth, toMonth), max);
  return Array.from({ length: span }, (_, i) => addMonths(toMonth, -i));
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 'May 2026' */
export function monthLabel(yyyyMM: string): string {
  const [y, m] = yyyyMM.split('-');
  return `${SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** 'May' */
export function monthShort(yyyyMM: string): string {
  return SHORT[Number(yyyyMM.slice(5, 7)) - 1] ?? yyyyMM;
}
