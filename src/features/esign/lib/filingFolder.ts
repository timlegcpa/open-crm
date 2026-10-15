import { FILING_FOLDER_MAX } from '../contract';

/**
 * The filing folder rule, as the server reads it (parseFilingFolder in
 * supabase/functions/esign-finalize-envelope/lib/settings.ts; parity.test.ts holds the two
 * equal). One folder name, or a path of up to five names separated by '/'. Each name is 1
 * to 100 characters with no backslash, control or invisible format character, and is not
 * '.' or '..'; the whole path is at most 198 characters. The server files into the default
 * folder rather than fail a signed envelope over a setting it cannot use, so the page
 * refuses such a setting before it is saved.
 */
const FOLDER_NAME = /^[^/\\\p{Cc}\p{Cf}]{1,100}$/u;
const MAX_DEPTH = 5;

const partsOf = (value: string) =>
  value
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

/** The folder chain a setting names, outermost first, or null when the server would refuse it. */
export function parseFilingFolder(value: string): string[] | null {
  const parts = partsOf(value);
  if (parts.length === 0 || parts.length > MAX_DEPTH) return null;
  for (const p of parts) {
    if (!FOLDER_NAME.test(p) || p === '.' || p === '..') return null;
  }
  if (parts.join('/').length > FILING_FOLDER_MAX) return null;
  return parts;
}

/** The setting as it is saved: the chain the server will read, joined with '/'. */
export function normalizeFilingFolder(value: string): string {
  return (parseFilingFolder(value) ?? []).join('/');
}

export function filingFolderProblem(value: string): string | null {
  if (parseFilingFolder(value)) return null;
  const parts = partsOf(value);
  if (parts.length === 0) return 'Enter a folder name.';
  if (parts.length > MAX_DEPTH) return `Use at most ${MAX_DEPTH} folder levels.`;
  if (parts.some((p) => [...p].length > 100)) return 'Keep each folder name to 100 characters.';
  if (parts.join('/').length > FILING_FOLDER_MAX) return `Keep the whole path to ${FILING_FOLDER_MAX} characters.`;
  if (parts.some((p) => p === '.' || p === '..')) return 'A folder cannot be named with dots alone.';
  return 'A folder name cannot contain a backslash, a control character or an invisible character.';
}
