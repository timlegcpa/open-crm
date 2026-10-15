// The SMS code: six uniform digits, and the HMAC the database stores in its place.
//
// code_hash = hex(HMAC-SHA256(ESIGN_SMS_CODE_KEY, signer_id + ':' + code)). The key lives
// only in the functions, so a reader of the table cannot test the million codes against
// a hash; the signer id in the message makes one signer's hash useless for another.

/** A code lives this long. */
export const SMS_CODE_MINUTES = 10;
/** Wrong guesses one code survives before it is locked. */
export const SMS_MAX_ATTEMPTS = 5;
/** A verified code buys a session this long, pinned to the address that verified it. */
export const SMS_SESSION_MINUTES = 30;
/** Codes one signer may be sent per hour, and in all. */
export const SMS_PER_HOUR = 3;
export const SMS_LIFETIME = 10;

export const SMS_CODE_PATTERN = /^[0-9]{6}$/;
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/** True when the configured key is 32 bytes of hex. */
export function isSmsCodeKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && KEY_HEX.test(value);
}

/**
 * Six digits, uniform: a random 32-bit value is redrawn while it falls in the incomplete
 * last block, so every code from 000000 to 999999 is equally likely.
 */
export function randomSixDigits(random: (buf: Uint32Array<ArrayBuffer>) => Uint32Array = (b) => crypto.getRandomValues(b)): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    const v = random(buf)[0];
    if (v < limit) return String(v % 1_000_000).padStart(6, '0');
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function smsCodeHash(keyHex: string, signerId: string, code: string): Promise<string> {
  if (!isSmsCodeKey(keyHex)) throw new Error('ESIGN_SMS_CODE_KEY must be 32 bytes of hex');
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${signerId}:${code}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}
