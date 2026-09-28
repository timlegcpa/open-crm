/**
 * Extract a user-facing message from an unknown error value.
 *
 * Replaces the `err instanceof Error ? err.message : '...'` pattern
 * that appears in 60+ catch blocks across the codebase.
 */
export function getErrorMessage(err: unknown, fallback = 'An unexpected error occurred'): string {
  if (err instanceof Error) return err.message;
  // Supabase throws PLAIN OBJECTS, not Error instances -- PostgrestError,
  // FunctionsError and StorageError all carry `message` without extending
  // Error. `instanceof` alone therefore fell through to the fallback, and 27
  // call sites pass `String(err)` as that fallback, which renders the literal
  // string "[object Object]". That is what a failing RLS write looked like in
  // the UI: a red toast with no message. It hid the 42P17 recursion regression
  // on client_documents/folders/messages/tasks for five days (2026-08-25).
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}
