/**
 * Display formatting for money, dates and times. The one place these are defined: a screen
 * never builds its own `toLocaleString` call.
 *
 * Every function takes the nullable column straight from the database and returns
 * NO_VALUE_TEXT for null, undefined or an unparseable value, so call sites need no guard.
 *
 * Locale and currency are fixed here (APP_LOCALE, APP_CURRENCY). An install that needs
 * another changes these two constants; nothing else names a locale.
 */

export const APP_LOCALE = 'en-US';
export const APP_CURRENCY = 'USD';

/** The one "no value here" glyph: an en dash. Never an em dash on any screen. */
export const NO_VALUE_TEXT = '–';

// ── Parsing ─────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;

/**
 * A Postgres `date` ('YYYY-MM-DD') is a calendar day with no zone, so it is read as LOCAL
 * midnight. `new Date('2026-04-07')` would read UTC midnight, which is the previous day
 * everywhere west of Greenwich. A `timestamptz` keeps its instant.
 */
function parse(value: string | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const day = DATE_ONLY.exec(value);
  const month = day ? null : MONTH_ONLY.exec(value);
  const d = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : month
      ? new Date(Number(month[1]), Number(month[2]) - 1, 1)
      : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type DateInput = string | Date | null | undefined;

function formatWith(value: DateInput, format: Intl.DateTimeFormat): string {
  if (!value) return NO_VALUE_TEXT;
  const d = parse(value);
  return d ? format.format(d) : NO_VALUE_TEXT;
}

// Intl formatters are expensive to build, so each is built once.
const DATE = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short', day: 'numeric' });
const DATE_LONG = new Intl.DateTimeFormat(APP_LOCALE, { month: 'long', day: 'numeric', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat(APP_LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const TIME = new Intl.DateTimeFormat(APP_LOCALE, { hour: 'numeric', minute: '2-digit' });
const MONTH_YEAR = new Intl.DateTimeFormat(APP_LOCALE, { month: 'long', year: 'numeric' });

// ── Dates ───────────────────────────────────────────────────────

/** "Apr 7, 2026" */
export function formatDate(value: DateInput): string {
  return formatWith(value, DATE);
}

/** "Apr 7" (no year), for rows already grouped by year. */
export function formatDateShort(value: DateInput): string {
  return formatWith(value, DATE_SHORT);
}

/** "April 7, 2026" */
export function formatDateLong(value: DateInput): string {
  return formatWith(value, DATE_LONG);
}

/** "Apr 7, 2026, 3:45 PM" */
export function formatDateTime(value: DateInput): string {
  return formatWith(value, DATE_TIME);
}

/** "3:45 PM", for rows already grouped under a date. */
export function formatTime(value: DateInput): string {
  return formatWith(value, TIME);
}

/** "July 2026". Also takes a bare 'YYYY-MM' month key. */
export function formatMonthYear(value: DateInput): string {
  return formatWith(value, MONTH_YEAR);
}

/**
 * A Date as the 'YYYY-MM-DD' calendar day it is IN THE LOCAL ZONE. Never
 * `toISOString().slice(0, 10)`, which is the UTC day and reads as tomorrow every evening
 * west of Greenwich.
 */
export function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today's local calendar day as 'YYYY-MM-DD'. */
export function todayISODate(): string {
  return toISODate(new Date());
}

/**
 * The inverse of toISODate: a 'YYYY-MM-DD' day, or a 'YYYY-MM' month key (its 1st), as a
 * LOCAL Date. Null for anything else, including a day that does not exist ('2026-02-31').
 */
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const day = DATE_ONLY.exec(value);
  const month = day ? null : MONTH_ONLY.exec(value);
  const parts = day ?? month;
  if (!parts) return null;
  const y = Number(parts[1]);
  const m = Number(parts[2]) - 1;
  const dd = day ? Number(day[3]) : 1;
  const d = new Date(y, m, dd);
  return d.getFullYear() === y && d.getMonth() === m && d.getDate() === dd ? d : null;
}

/**
 * Whole LOCAL calendar days from `from` to `now` (positive when `from` is in the past).
 * Both ends are floored to local midnight, so "yesterday at 11pm" is 1, and a daylight-saving
 * night is still one day. Unparseable input is 0.
 */
export function wholeDaysBetween(from: DateInput, now: Date = new Date()): number {
  if (!from) return 0;
  const start = parse(from);
  if (!start) return 0;
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

const RELATIVE = new Intl.RelativeTimeFormat(APP_LOCALE, { numeric: 'auto' });

/**
 * "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", then the date.
 * Future instants read the same way ("in 5 minutes", "tomorrow"). Days are calendar days,
 * so "yesterday" means the previous date, not the previous 24 hours.
 */
export function formatRelativeTime(value: DateInput, now: Date = new Date()): string {
  if (!value) return NO_VALUE_TEXT;
  const then = parse(value);
  if (!then) return NO_VALUE_TEXT;
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  if (Math.abs(seconds) < 45 * 60) return RELATIVE.format(-Math.round(seconds / 60), 'minute');
  const days = wholeDaysBetween(then, now);
  if (days === 0) return RELATIVE.format(-Math.round(seconds / 3600), 'hour');
  if (Math.abs(days) < 7) return RELATIVE.format(-days, 'day');
  return formatDate(then);
}

// ── Money ───────────────────────────────────────────────────────

const CURRENCY_CACHE = new Map<number, Intl.NumberFormat>();

function currencyFormat(decimals: number): Intl.NumberFormat {
  let format = CURRENCY_CACHE.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat(APP_LOCALE, {
      style: 'currency',
      currency: APP_CURRENCY,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    CURRENCY_CACHE.set(decimals, format);
  }
  return format;
}

/** "$1,234.56"; `decimals` 0 gives "$1,235". */
export function formatCurrency(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_VALUE_TEXT;
  return currencyFormat(decimals).format(value);
}

/** "$1,235" */
export function formatCurrencyShort(value: number | null | undefined): string {
  return formatCurrency(value, 0);
}

const ACCOUNTING = new Intl.NumberFormat(APP_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Accounting style: "1,234.56", "(1,234.56)" for a negative, "-" for zero or no value.
 * `prefix` sits inside the parentheses ("$ " gives "($ 500.00)"); `dashForZero: false`
 * prints zero as "0.00".
 */
export function formatAccounting(
  value: number | null | undefined,
  opts: { dashForZero?: boolean; prefix?: string } = {},
): string {
  const { dashForZero = true, prefix = '' } = opts;
  if (value === null || value === undefined || Number.isNaN(value)) return dashForZero ? '-' : '';
  if (dashForZero && value === 0) return '-';
  const text = prefix + ACCOUNTING.format(Math.abs(value));
  return value < 0 ? `(${text})` : text;
}

// ── Other ───────────────────────────────────────────────────────

/** A 10-digit number as "(555) 010-0001"; anything else comes back unchanged. */
export function formatPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone;
}

/** "512 B", "1.5 KB", "2.3 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "report.final.pdf" is { name: "report.final", ext: ".pdf" }; a dotfile has no extension. */
export function splitFilename(filename: string): { name: string; ext: string } {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return { name: filename, ext: '' };
  return { name: filename.slice(0, lastDot), ext: filename.slice(lastDot) };
}
