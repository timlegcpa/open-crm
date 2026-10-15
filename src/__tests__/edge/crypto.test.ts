// @vitest-environment node
// The three wire formats, proven against an independent AES-GCM implementation
// (node:crypto), not only against themselves: a value node writes in the documented
// layout opens here, and a value written here opens in node.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptDocument,
  decryptPii,
  decryptPiiSplit,
  encryptDocument,
  encryptPii,
  encryptPiiSplit,
  fromBytea,
  importAesKey,
  randomTokenBase64Url,
  sha256Hex,
  toByteaHex,
} from '../../../supabase/functions/_shared/crypto';

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString('base64');
const OTHER_KEY_B64 = randomBytes(32).toString('base64');
const IV = Buffer.from('000102030405060708090a0b', 'hex');
const PLAIN = 'Ada Example, 555-010-4477';

function nodeSeal(plaintext: Uint8Array, key = KEY, iv = IV) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { body, tag: cipher.getAuthTag() };
}

function nodeOpen(body: Uint8Array, tag: Uint8Array, iv: Uint8Array, key = KEY): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

describe('keys', () => {
  it('refuses anything that is not exactly 32 bytes of base64', async () => {
    await expect(importAesKey(randomBytes(16).toString('base64'), 'encrypt')).rejects.toThrow(/32 bytes/);
    await expect(importAesKey(randomBytes(24).toString('base64'), 'encrypt')).rejects.toThrow(/32 bytes/);
    await expect(importAesKey(randomBytes(33).toString('base64'), 'encrypt')).rejects.toThrow(/32 bytes/);
    await expect(importAesKey('', 'encrypt')).rejects.toThrow(/32 bytes/);
    await expect(importAesKey('not base64 at all!', 'encrypt')).rejects.toThrow(/not base64/);
    await expect(importAesKey(KEY_B64, 'encrypt')).resolves.toBeDefined();
  });

  it('refuses a short key on every path, encrypting or decrypting', async () => {
    const short = randomBytes(16).toString('base64');
    await expect(encryptDocument(new Uint8Array(4), short)).rejects.toThrow(/32 bytes/);
    await expect(encryptPii(PLAIN, short)).rejects.toThrow(/32 bytes/);
    await expect(encryptPiiSplit(PLAIN, short)).rejects.toThrow(/32 bytes/);
    const blob = await encryptPii(PLAIN, KEY_B64);
    await expect(decryptPii(blob, short)).rejects.toThrow(/32 bytes/);
  });
});

describe('document format: ciphertext+tag as the object, 12-byte IV base64 in the row', () => {
  it('round-trips bytes, with a fresh IV each time', async () => {
    const data = randomBytes(70_000);
    const a = await encryptDocument(data, KEY_B64);
    const b = await encryptDocument(data, KEY_B64);
    expect(base64ToBytes(a.iv)).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).toHaveLength(data.length + 16);
    expect(Buffer.from(await decryptDocument(a.ciphertext, a.iv, KEY_B64))).toEqual(data);
  });

  it('opens what node writes in that layout, and node opens what it writes', async () => {
    const data = new TextEncoder().encode('%PDF-1.7 fictional statement');
    const { body, tag } = nodeSeal(data);
    expect(new TextDecoder().decode(await decryptDocument(concat(body, tag), IV.toString('base64'), KEY_B64))).toBe(
      '%PDF-1.7 fictional statement',
    );

    const ours = await encryptDocument(data, KEY_B64);
    const opened = nodeOpen(ours.ciphertext.subarray(0, -16), ours.ciphertext.subarray(-16), base64ToBytes(ours.iv));
    expect(new Uint8Array(opened)).toEqual(data);
  });

  it('fails on the wrong key, a flipped bit, or an IV that is not 12 bytes', async () => {
    const { ciphertext, iv } = await encryptDocument(new Uint8Array([1, 2, 3]), KEY_B64);
    await expect(decryptDocument(ciphertext, iv, OTHER_KEY_B64)).rejects.toThrow();
    const flipped = new Uint8Array(ciphertext);
    flipped[0] ^= 1;
    await expect(decryptDocument(flipped, iv, KEY_B64)).rejects.toThrow();
    await expect(decryptDocument(ciphertext, bytesToBase64(new Uint8Array(16)), KEY_B64)).rejects.toThrow(/12 bytes/);
  });
});

describe('pii format: 0x01 || IV || ciphertext+tag in one bytea', () => {
  it('round-trips text, and stores empty as empty', async () => {
    const blob = await encryptPii(PLAIN, KEY_B64);
    expect(blob[0]).toBe(0x01);
    expect(blob).toHaveLength(1 + 12 + new TextEncoder().encode(PLAIN).length + 16);
    expect(await decryptPii(blob, KEY_B64)).toBe(PLAIN);
    expect(await encryptPii('', KEY_B64)).toEqual(new Uint8Array(0));
    expect(await decryptPii(new Uint8Array(0), KEY_B64)).toBe('');
    expect(await decryptPii(await encryptPii('café ✓', KEY_B64), KEY_B64)).toBe('café ✓');
  });

  it('opens what node writes in that layout, and node opens what it writes', async () => {
    const { body, tag } = nodeSeal(new TextEncoder().encode(PLAIN));
    expect(await decryptPii(concat(Uint8Array.of(0x01), IV, body, tag), KEY_B64)).toBe(PLAIN);

    const ours = await encryptPii(PLAIN, KEY_B64);
    expect(nodeOpen(ours.subarray(13, -16), ours.subarray(-16), ours.subarray(1, 13)).toString('utf8')).toBe(PLAIN);
  });

  it('refuses an unknown version byte and fails on the wrong key or tampering', async () => {
    const blob = await encryptPii(PLAIN, KEY_B64);
    const v2 = new Uint8Array(blob);
    v2[0] = 0x02;
    await expect(decryptPii(v2, KEY_B64)).rejects.toThrow(/version/);
    await expect(decryptPii(blob, OTHER_KEY_B64)).rejects.toThrow();
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptPii(tampered, KEY_B64)).rejects.toThrow();
  });
});

describe('pii split format: ciphertext+tag and IV in two bytea columns', () => {
  it('round-trips, and matches node in both directions', async () => {
    const { ciphertext, iv } = await encryptPiiSplit('+15555550123', KEY_B64);
    expect(iv).toHaveLength(12);
    expect(await decryptPiiSplit(ciphertext, iv, KEY_B64)).toBe('+15555550123');
    expect(nodeOpen(ciphertext.subarray(0, -16), ciphertext.subarray(-16), iv).toString('utf8')).toBe('+15555550123');

    const { body, tag } = nodeSeal(new TextEncoder().encode('+15555550199'));
    expect(await decryptPiiSplit(concat(body, tag), IV, KEY_B64)).toBe('+15555550199');
  });

  it('fails on the wrong key and on a short IV', async () => {
    const { ciphertext, iv } = await encryptPiiSplit('+15555550123', KEY_B64);
    await expect(decryptPiiSplit(ciphertext, iv, OTHER_KEY_B64)).rejects.toThrow();
    await expect(decryptPiiSplit(ciphertext, iv.subarray(0, 11), KEY_B64)).rejects.toThrow(/12 bytes/);
  });
});

describe('bytea and base64 helpers', () => {
  it('writes the PostgREST hex literal and reads it back', () => {
    const value = Uint8Array.of(0x01, 0xab, 0x00, 0xff);
    const hex = toByteaHex(value);
    expect(hex.length).toBe(10);
    expect(hex.charCodeAt(0)).toBe(92); // a single backslash
    expect(hex.slice(1)).toBe('x01ab00ff');
    expect(fromBytea(hex)).toEqual(value);
    expect(fromBytea('01ab00ff')).toEqual(value);
    expect(fromBytea(value)).toBe(value);
  });

  it('refuses a value that is not hex or bytes, rather than reading it as empty', () => {
    for (const bad of [toByteaHex(Uint8Array.of(1)).slice(0, -1), toByteaHex(Uint8Array.of(1)).replace('01', 'zz'), 42, null, {}]) {
      expect(() => fromBytea(bad)).toThrow();
    }
  });

  it('round-trips base64 across the chunk boundary', () => {
    const big = randomBytes(0x8000 * 2 + 7);
    expect(bytesToBase64(big)).toBe(big.toString('base64'));
    expect(Buffer.from(base64ToBytes(big.toString('base64')))).toEqual(big);
  });

  it('a pii value survives the trip through a bytea column', async () => {
    const blob = await encryptPii(PLAIN, KEY_B64);
    expect(await decryptPii(fromBytea(toByteaHex(blob)), KEY_B64)).toBe(PLAIN);
  });
});

describe('tokens and hashes', () => {
  it('sha256Hex is the SHA-256 of the UTF-8 bytes, in lowercase hex', async () => {
    for (const input of ['', 'token-abc_123', 'Ada Lovelace é\u{1F600}']) {
      expect(await sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });

  it('randomTokenBase64Url is 32 random bytes as unpadded base64url', () => {
    const a = randomTokenBase64Url();
    const b = randomTokenBase64Url();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});
