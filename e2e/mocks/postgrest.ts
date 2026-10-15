/**
 * Just enough PostgREST for the app's reads and writes against in-memory fixture tables:
 * top-level filters (eq, neq, is, in, gt, gte, lt, lte, like, ilike), limit, offset and the
 * Range header. Embedded-resource filters and `or=` are ignored, so a fixture row carries its
 * embedded objects already and a scenario keeps a table to the rows a screen should show.
 */

export type Row = Record<string, unknown>;

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);

function parseList(value: string): string[] {
  const inner = value.replace(/^\(/, '').replace(/\)$/, '');
  if (inner === '') return [];
  return inner.split(',').map((item) => item.trim().replace(/^"(.*)"$/, '$1'));
}

function compare(actual: unknown, op: string, expected: string): boolean {
  if (op === 'is') {
    if (expected === 'null') return actual === null || actual === undefined;
    if (expected === 'true') return actual === true;
    if (expected === 'false') return actual === false;
    return true;
  }
  if (op === 'in') return parseList(expected).includes(String(actual));
  if (actual === null || actual === undefined) return op === 'neq';
  const text = String(actual);
  switch (op) {
    case 'eq':
      return text === expected;
    case 'neq':
      return text !== expected;
    case 'gt':
      return text > expected;
    case 'gte':
      return text >= expected;
    case 'lt':
      return text < expected;
    case 'lte':
      return text <= expected;
    case 'like':
    case 'ilike': {
      const pattern = expected.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*');
      return new RegExp(`^${pattern}$`, op === 'ilike' ? 'i' : '').test(text);
    }
    default:
      return true;
  }
}

/** True when the row passes every top-level filter in the query string. */
export function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (RESERVED.has(key) || key.includes('.')) continue;
    let value = raw;
    let negate = false;
    if (value.startsWith('not.')) {
      negate = true;
      value = value.slice(4);
    }
    const dot = value.indexOf('.');
    if (dot < 0) continue;
    const op = value.slice(0, dot);
    const expected = decodeURIComponent(value.slice(dot + 1));
    const ok = compare(row[key], op, expected);
    if (negate ? ok : !ok) return false;
  }
  return true;
}

/** The slice a limit/offset or Range header asks for. */
export function page(rows: Row[], params: URLSearchParams, range: string | undefined): Row[] {
  let start = Number(params.get('offset') ?? 0);
  let end = params.has('limit') ? start + Number(params.get('limit')) - 1 : rows.length - 1;
  const match = range?.match(/^(\d+)-(\d+)$/);
  if (match) {
    start = Number(match[1]);
    end = Number(match[2]);
  }
  return rows.slice(start, end + 1);
}

/**
 * An embedded `alias:table(count)` in the select answers `[{ count }]`, not the rows. A fixture
 * keeps the embedded rows themselves, so a screen that reads them and one that counts them
 * share the same row.
 */
export function project(rows: Row[], select: string | null): Row[] {
  if (!select) return rows;
  const counted = [...select.matchAll(/(?:^|,)\s*(?:(\w+):)?(\w+)\(count\)/g)].map((m) => m[1] ?? m[2]);
  if (counted.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const field of counted) out[field] = [{ count: Array.isArray(row[field]) ? (row[field] as unknown[]).length : 0 }];
    return out;
  });
}
