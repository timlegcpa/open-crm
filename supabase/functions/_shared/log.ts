// Logging that keeps personal data out of function logs.
//
// Three layers, each a backstop for the one before:
//   errSummary   an error becomes its SQLSTATE code and message only. Postgres puts
//                row VALUES in `details` and `hint` ("Failing row contains (...)",
//                "Key (email)=(...) already exists"), and data-type errors quote the
//                bad input in the message itself, so the object is never logged.
//   redactText   emails, phone numbers and other long digit runs (dates of birth,
//                account numbers), bearer and JWT tokens, key=value secrets and long
//                opaque strings are replaced before a line is written. UUIDs are kept:
//                ids are how a log line is traced back to a row.
//   fields       structured context accepts ids, numbers, booleans and short
//                lowercase codes. Anything else (a name, an address, free text) is
//                written as [redacted], since no pattern can recognise a name.
//
// The one rule for callers: log an event name, the error, and ids. Never a value a
// person typed.

/**
 * A loggable one-liner for a thrown or returned error: SQLSTATE code plus message,
 * nothing else. A `: "..."` tail is redacted to the end (a value may itself contain a
 * quote); constraint and relation names (`constraint "chk_x"`, no colon) are kept.
 */
export function errSummary(err: unknown): string {
  const redact = (s: string) => s.replace(/:\s*".*$/s, ': "[redacted]"').slice(0, 200);
  // JSON.parse's message quotes a fragment of its input with no `: "` prefix, and the
  // input here is often decrypted personal data.
  if (err instanceof SyntaxError) return 'SyntaxError';
  if (err instanceof Error) return redact(err.message);
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    const code = typeof e.code === 'string' && e.code ? `[${e.code}] ` : '';
    if (typeof e.message === 'string' && e.message) return redact(`${code}${e.message}`);
    if (code) return code.trim();
  }
  return 'unknown';
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// UUIDs are parked behind a private-use character while the other rules run, so the
// digit and opaque-string rules cannot eat them.
const MARK = String.fromCharCode(0xe000);
const PARKED = new RegExp(MARK + '([0-9]+)' + MARK, 'g');
const MAX_LINE = 2000;

/** Replace personal data and credentials in free text. UUIDs survive. */
export function redactText(text: string): string {
  const parked: string[] = [];
  let out = text
    .slice(0, MAX_LINE)
    .replaceAll(MARK, '')
    .replace(UUID_ANYWHERE, (m) => `${MARK}${parked.push(m) - 1}${MARK}`);
  out = out
    // Postgres echoes of row values, in case one reached a message.
    .replace(/Failing row contains \(.*\)/gs, 'Failing row contains ([redacted])')
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '($1)=([redacted])')
    // Credentials.
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [token]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[token]')
    // Personal data.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    // Long opaque strings with both letters and digits: API keys, hex secrets, signed links.
    .replace(/(?=[A-Za-z0-9_+/-]*\d)(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]{24,}={0,2}/g, '[token]')
    // Seven or more digits, however separated: phone numbers, dates, account numbers.
    .replace(/\+?\(?\d(?:[\s().-]*\d){6,}/g, '[number]');
  return out.replace(PARKED, (_, i: string) => parked[Number(i)]);
}

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;
export type LogLevel = 'error' | 'warn' | 'info';
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  error(event: string, err?: unknown, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
}

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A field value as it may appear in a log line: ids, numbers, booleans and codes only.
 * Codes and numbers still pass the redactor, so a phone number is not a code.
 */
export function safeFieldValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? redactText(String(value)) : '[redacted]';
  if (typeof value === 'string') {
    if (UUID_EXACT.test(value)) return value;
    if (CODE.test(value)) return redactText(value);
  }
  return '[redacted]';
}

const defaultSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

/**
 * A logger whose every line is one redacted string: `[name] rid=<id> event: summary k=v`.
 * One string, so the runtime never serialises an object into the log.
 */
export function createLogger(name: string, opts: { requestId?: string; sink?: LogSink } = {}): Logger {
  const sink = opts.sink ?? defaultSink;
  const prefix = `[${name}]${opts.requestId ? ` rid=${opts.requestId}` : ''}`;
  const render = (event: string, summary: string | null, fields?: LogFields): string => {
    let line = `${prefix} ${redactText(event)}`;
    if (summary !== null) line += `: ${redactText(summary)}`;
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (FIELD_KEY.test(key)) line += ` ${key}=${safeFieldValue(value)}`;
    }
    return line;
  };
  return {
    error: (event, err, fields) => sink('error', render(event, err === undefined ? null : errSummary(err), fields)),
    warn: (event, fields) => sink('warn', render(event, null, fields)),
    info: (event, fields) => sink('info', render(event, null, fields)),
  };
}
