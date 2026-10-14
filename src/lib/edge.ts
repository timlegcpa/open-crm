import { getSupabase } from '@/lib/supabase';
import { EdgeError, assertFunctionName, edgeErrorFromResponse, isEdgeError, parseAnswer } from '@/lib/edgeCore';

export { EdgeError, EDGE_ERROR_MESSAGES, isEdgeError, type EdgeErrorKind } from '@/lib/edgeCore';

/**
 * Calling an edge function as the signed-in user (the owner, or a client in the portal).
 *
 * `supabase.functions.invoke` attaches the session's access token, so the function sees who
 * is calling and checks it itself (`is_owner()`, `get_client_contact_id()`). Every failure
 * is thrown as an `EdgeError` (see `edgeCore.ts`): branch on `err.kind` / `err.code`, show
 * `err.message`, which never carries server internals.
 *
 * Public pages (no session) must not import this module; they use `publicEdge.ts`.
 */

export type InvokeBody = Record<string, unknown> | unknown[] | FormData | Blob | ArrayBuffer | string;

export interface InvokeOptions<T> {
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Validates the success body, e.g. a Zod schema's `parse`. A throw becomes an EdgeError. */
  parse?: (data: unknown) => T;
}

/**
 * Turns what `functions.invoke` returned as `error` (or threw) into an EdgeError. Never throws.
 * An HTTP or relay error carries the Response on `error.context`; a fetch error does not.
 */
export async function toEdgeError(error: unknown, signal?: AbortSignal): Promise<EdgeError> {
  if (isEdgeError(error)) return error;
  if (signal?.aborted) return new EdgeError('aborted');
  const context = (error as { context?: unknown } | null)?.context as
    | { status?: unknown; text?: unknown }
    | undefined;
  if (context && typeof context.status === 'number' && typeof context.text === 'function') {
    return edgeErrorFromResponse(context as { status: number; text: () => Promise<string> });
  }
  return new EdgeError('network');
}

/**
 * POST `body` to the function `name` with the session token; resolves to the parsed answer
 * (JSON as an object, text as a string, a file as a Blob).
 */
export async function invokeEdge<T = unknown>(name: string, body?: InvokeBody, options: InvokeOptions<T> = {}): Promise<T> {
  assertFunctionName(name);
  let result: { data: unknown; error: unknown };
  try {
    result = await getSupabase().functions.invoke(name, {
      // supabase-js types the body as its own union; InvokeBody is a subset of it.
      body: body as never,
      method: options.method ?? 'POST',
      headers: options.headers,
      signal: options.signal,
      timeout: options.timeoutMs,
    });
  } catch (err) {
    throw await toEdgeError(err, options.signal);
  }
  if (result.error) throw await toEdgeError(result.error, options.signal);
  return parseAnswer(result.data, options.parse);
}
