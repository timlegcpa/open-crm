/**
 * The error contract every edge-function call in the browser shares, signed in or not.
 * Pure: no supabase-js here, so public pages can use it (see `publicEdge.ts`).
 *
 * The rule it enforces: a server's internals never reach the screen. A function's JSON
 * error body may carry a sentence written for people (`{ "error": "Sign in again." }`) or a
 * machine code (`{ "error": "delete_in_progress" }`, or a separate `code` field). On a 4xx a
 * sentence is shown as written; anything else, and every 5xx (where crashes, stack traces
 * and gateway pages land), is replaced by a fixed message for its kind. Callers branch on
 * `kind` and `code`, never on the message text.
 */

export type EdgeErrorKind =
  | 'network'
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'rate_limited'
  | 'invalid'
  | 'server';

export const EDGE_ERROR_MESSAGES: Readonly<Record<EdgeErrorKind, string>> = Object.freeze({
  network: 'Could not reach the server. Check your connection and try again.',
  aborted: 'The request was cancelled.',
  unauthorized: 'Your session has ended. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'That item could not be found. It may have been removed.',
  conflict: 'That could not be done right now because something changed. Reload and try again.',
  too_large: 'That is too large to send.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  invalid: 'The request was not accepted. Check what you entered and try again.',
  server: 'Something went wrong on the server. Try again.',
});

/** Shown when a 2xx body is not the shape the page expected. */
export const UNREADABLE_ANSWER = 'The server sent an answer this page does not understand. Try again.';

export class EdgeError extends Error {
  readonly kind: EdgeErrorKind;
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /** The server's machine-readable code (`snake_case`), when it sent one. */
  readonly code: string | null;

  constructor(kind: EdgeErrorKind, opts: { status?: number | null; code?: string | null; message?: string } = {}) {
    super(opts.message ?? EDGE_ERROR_MESSAGES[kind]);
    this.name = 'EdgeError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

export function isEdgeError(value: unknown): value is EdgeError {
  return value instanceof EdgeError;
}

const FUNCTION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Function names are code constants; anything else (a path, a query) is a bug. */
export function assertFunctionName(name: string): void {
  if (!FUNCTION_NAME.test(name)) throw new Error(`Not an edge function name: ${JSON.stringify(name)}`);
}

export function kindForStatus(status: number): EdgeErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid';
  return 'server';
}

const MACHINE_CODE = /^[a-z][a-z0-9_]{1,63}$/;
/** One line, starts with a capital, ends with terminal punctuation, no markup. */
const SENTENCE = /^[A-Z][^<>{}\r\n]{0,198}[.!?]$/;

/** What of a function's error body may be used: a 4xx sentence for people, and a code. */
export function readErrorBody(status: number, body: unknown): { message: string | null; code: string | null } {
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const error = typeof record?.error === 'string' ? record.error.trim() : null;
  const explicitCode = typeof record?.code === 'string' && MACHINE_CODE.test(record.code) ? record.code : null;
  const code = explicitCode ?? (error !== null && MACHINE_CODE.test(error) ? error : null);
  const message = status >= 400 && status < 500 && error !== null && SENTENCE.test(error) ? error : null;
  return { message, code };
}

export function edgeErrorFromBody(status: number, body: unknown): EdgeError {
  const { message, code } = readErrorBody(status, body);
  return new EdgeError(kindForStatus(status), { status, code, message: message ?? undefined });
}

/** A non-2xx Response, whatever its body (JSON, text, an HTML gateway page), as an EdgeError. Never throws. */
export async function edgeErrorFromResponse(res: { status: number; text: () => Promise<string> }): Promise<EdgeError> {
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return edgeErrorFromBody(res.status, body);
}

/** Run a caller's validator over a 2xx body; a throw becomes an EdgeError, never a raw parse error. */
export function parseAnswer<T>(data: unknown, parse: ((data: unknown) => T) | undefined): T {
  if (!parse) return data as T;
  try {
    return parse(data);
  } catch {
    throw new EdgeError('server', { message: UNREADABLE_ANSWER });
  }
}
