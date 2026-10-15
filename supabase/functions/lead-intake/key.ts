// The lead-intake key: how one is made (lead-intake-key) and how a presented one is
// checked (lead-intake). Pure TypeScript over WebCrypto. lead-intake-key imports this
// file by path, so there is one copy; the hash and the random token come from
// _shared/crypto.ts.
//
// A key is 'lik_' and 32 random bytes in base64url (47 characters). Only its SHA-256 hex
// digest is stored (lead_intake_keys.key_hash). The key is sent server to server, in
// x-api-key, as `Authorization: Bearer <key>`, or as a bare Authorization value (the shared
// handler's apiKey mode reads it: presentedApiKey in _shared/http.ts). It must never be put
// in a web page: anyone who reads the page source could then post leads.

import { randomTokenBase64Url, sha256Hex } from '../_shared/crypto.ts';
import { timingSafeEqual } from '../_shared/secrets.ts';

export const KEY_PREFIX = 'lik_';
/** How many leading characters of a key the owner sees afterwards, to tell keys apart. */
export const KEY_HINT_LENGTH = 8;

export function newLeadIntakeKey(): string {
  return KEY_PREFIX + randomTokenBase64Url();
}

/**
 * The check for one isolate. The stored digest (or its absence) is cached for `ttlMs`
 * (default 60 s), so a flood of wrong keys costs a hash and a compare, not a database
 * read each. The price is that a rotated or revoked key keeps working, and a new one
 * stays refused, for up to that long; the settings page says so. A failed read is not
 * cached and throws: the caller answers "unavailable", never "allowed".
 */
export function createKeyVerifier(deps: {
  loadKeyHash(): Promise<string | null>;
  ttlMs?: number;
  now?: () => number;
}): { verify(presented: string | null): Promise<boolean> } {
  const ttl = deps.ttlMs ?? 60_000;
  const now = deps.now ?? (() => Date.now());
  let cached: { hash: string | null; at: number } | null = null;

  async function storedHash(): Promise<string | null> {
    if (cached && now() - cached.at < ttl) return cached.hash;
    const hash = await deps.loadKeyHash();
    cached = { hash: hash && /^[0-9a-f]{64}$/.test(hash) ? hash : null, at: now() };
    return cached.hash;
  }

  return {
    async verify(presented) {
      if (!presented) return false;
      const stored = await storedHash();
      if (!stored) return false;
      return timingSafeEqual(await sha256Hex(presented), stored);
    },
  };
}
