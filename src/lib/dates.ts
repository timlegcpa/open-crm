/**
 * Two kinds of date reach the browser and they must not be confused:
 *  - a Postgres `date` ('YYYY-MM-DD') is a calendar day with no zone. `new Date()` on it
 *    reads UTC midnight, which is the previous day west of Greenwich, so it is split by hand.
 *  - a `timestamptz` is an instant, shown and edited in the viewer's own zone.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parse(value: string): Date | null {
  const m = DATE_ONLY.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Display either kind as a short local date; empty for null or unparseable input. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = parse(value);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

/** A timestamptz as the local calendar day for an `<input type="date">`. */
export function timestampToDateInput(value: string | null | undefined): string {
  if (!value) return '';
  const d = parse(value);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
}

/** An `<input type="date">` value as local midnight of that day, for a timestamptz column. */
export function dateInputToTimestamp(value: string): string | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

/** Sortable instant for either kind (0 when absent). */
export function dateSortKey(value: string | null | undefined): number {
  if (!value) return 0;
  return parse(value)?.getTime() ?? 0;
}
