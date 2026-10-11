/**
 * localStorage behind try/catch, because every access can throw: a private window, site
 * data blocked by the browser, a full quota, a sandboxed frame. Reading `window.localStorage`
 * itself throws a SecurityError in some of those, so even that is guarded.
 *
 * A value that cannot be read falls back to the caller's default; a value that cannot be
 * written lasts for this page view only. Use it for per-browser conveniences (theme, a
 * collapsed section, a remembered tab). Anything that must persist, be shared or be trusted
 * belongs in the database.
 */

const PREFIX = 'open-crm:';

/** Namespaced key: `storageKey('board', 'filters')` is `open-crm:board:filters`. */
export function storageKey(...parts: string[]): string {
  return PREFIX + parts.join(':');
}

function backingStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function get(key: string): string | null {
  try {
    return backingStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** False when the value could not be stored. */
function set(key: string, value: string): boolean {
  try {
    const store = backingStore();
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    backingStore()?.removeItem(key);
  } catch {
    // Nothing to undo: the value was never readable either.
  }
}

/** A stored JSON value, only when `guard` accepts its shape; otherwise null. */
function getJson<T>(key: string, guard: (value: unknown) => value is T): T | null {
  const raw = get(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setJson(key: string, value: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  return set(key, text);
}

export const safeStorage = { get, set, remove, getJson, setJson };
