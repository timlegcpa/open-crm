/**
 * The signing token travels in the URL FRAGMENT (`/sign#token=...`): a fragment is never sent
 * to a server, never written to an access log and never carried in a Referer. On arrival it
 * moves into sessionStorage (so a refresh mid-flow still works once the URL is clean) and is
 * stripped from the address bar. It dies with the tab and is cleared on every terminal state.
 */

export const TOKEN_STORAGE_KEY = 'esign:signing-token';

/** base64url, as the send function mints it; anything else is not a token. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** The token in a fragment (`#token=...`, alone or among other parameters), or null. */
export function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get('token');
  return value && TOKEN.test(value) ? value : null;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The token for this tab: from the fragment (stored, then stripped from the URL, keeping the
 * path and query), else the one stored earlier in this tab, else null.
 */
export function takeSigningToken(): string | null {
  if (typeof window === 'undefined') return null;
  const fromHash = tokenFromHash(window.location.hash);
  if (fromHash) {
    try {
      storage()?.setItem(TOKEN_STORAGE_KEY, fromHash);
    } catch {
      // Private mode: the flow still works until a refresh.
    }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    return fromHash;
  }
  try {
    const stored = storage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
    return stored && TOKEN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function clearSigningToken(): void {
  try {
    storage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
