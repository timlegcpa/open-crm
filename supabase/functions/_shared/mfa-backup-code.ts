// Two-factor backup codes, shared by mfa-backup-codes (issue, revoke) and mfa-recovery
// (redeem). Pure TypeScript: the key is passed in, so vitest runs it as-is. The token
// claims both functions read (jwtAssurance) live in auth.ts.
//
// Format: 20 Crockford Base32 characters shown as XXXXX-XXXXX-XXXXX-XXXXX, 100 bits each.
// 256 % 32 === 0, so `byte % 32` picks every character with exactly equal odds.
//
// Only an HMAC of a code is stored (mfa_backup_codes.code_hash), keyed from the service
// role key through a purpose string, so a leaked row cannot be checked offline without
// the server's secret. The other side of that: rotating the service role key (or moving
// to a new key format) silently invalidates every outstanding code. That is acceptable,
// because codes are regenerated from Settings, but an adopter who rotates the key must
// regenerate their codes.

import { MIN_SECRET_LENGTH } from './secrets.ts';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BACKUP_CODE_LENGTH = 20;
export const BACKUP_CODES_PER_SET = 8;

/** One code in display form: XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateBackupCode(): string {
  const bytes = new Uint8Array(BACKUP_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += CROCKFORD[b % 32];
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

/**
 * The compact 20-character form that is hashed, or null when the input is not a code.
 * Dashes, spaces and lowercase are accepted, and Crockford's look-alike letters map to
 * their digits (O to 0, I and L to 1), so a code copied by hand still works.
 */
export function normalizeBackupCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (compact.length !== BACKUP_CODE_LENGTH) return null;
  for (const ch of compact) if (!CROCKFORD.includes(ch)) return null;
  return compact;
}

/** The hasher for one isolate, keyed from the service role key. Throws on a short key. */
export function createBackupCodeHasher(serviceRoleKey: string): (compact: string) => Promise<string> {
  if (!serviceRoleKey || serviceRoleKey.length < MIN_SECRET_LENGTH) {
    throw new Error('the service role key is too short to key backup-code hashing');
  }
  const enc = new TextEncoder();
  let key: Promise<CryptoKey> | null = null;
  const derive = async (): Promise<CryptoKey> => {
    const root = await crypto.subtle.importKey('raw', enc.encode(serviceRoleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const derived = await crypto.subtle.sign('HMAC', root, enc.encode('mfa-backup-code/v1'));
    return await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  };
  return async (compact: string) => {
    key ??= derive();
    const sig = await crypto.subtle.sign('HMAC', await key, enc.encode(compact));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  };
}
