// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptMessage,
  deriveWrappingKey,
  encryptMessage,
  exportPublicKeyJwk,
  generateKeyPair,
  generateRecoveryKey,
  importPublicKeyJwk,
  newSalt,
  privateKeyOpens,
  recoverPrivateKey,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '../crypto';

// RSA-4096 key generation is slow; one pair serves most tests.
let pair: CryptoKeyPair;
beforeAll(async () => {
  pair = await generateKeyPair();
}, 60_000);

async function roundTrip(text: string, publicKey: CryptoKey, privateKey: CryptoKey): Promise<string> {
  const sealed = await encryptMessage(text, publicKey);
  return decryptMessage(sealed.ciphertext, sealed.encryptedSessionKey, sealed.iv, privateKey);
}

describe('secure-message cryptography', () => {
  it('makes an RSA-OAEP 4096 keypair', () => {
    expect(pair.publicKey.algorithm).toMatchObject({ name: 'RSA-OAEP', modulusLength: 4096 });
    expect(pair.privateKey.type).toBe('private');
  });

  it('derives an AES-GCM wrapping key from a password and salt', async () => {
    const key = await deriveWrappingKey('correct horse battery', newSalt());
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.usages).toEqual(expect.arrayContaining(['wrapKey', 'unwrapKey']));
    expect(key.extractable).toBe(false);
  });

  it('encrypts and decrypts, and the ciphertext does not carry the text', async () => {
    const secret = 'Account PIN 4417 for the north office';
    const sealed = await encryptMessage(secret, pair.publicKey);
    expect(atob(sealed.ciphertext)).not.toContain('4417');
    expect(atob(sealed.ciphertext)).not.toContain('north office');
    expect(await decryptMessage(sealed.ciphertext, sealed.encryptedSessionKey, sealed.iv, pair.privateKey)).toBe(secret);
  });

  it('produces the lengths the database bounds (684-character sealed key, 16-character IV)', async () => {
    const sealed = await encryptMessage('x', pair.publicKey);
    expect(sealed.encryptedSessionKey).toHaveLength(684);
    expect(sealed.iv).toHaveLength(16);
    expect(sealed.ciphertext).toHaveLength(24);
    // The longest body the browser allows, all three-byte characters, stays within 40,024.
    const longest = await encryptMessage('€'.repeat(10_000), pair.publicKey);
    expect(longest.ciphertext.length).toBe(40_024);
  });

  it('wraps and unwraps the private key under a password', async () => {
    const salt = newSalt();
    const { encryptedKey, iv } = await wrapPrivateKey(pair.privateKey, await deriveWrappingKey('Wrap-Pass-0001', salt));
    const unwrapped = await unwrapPrivateKey(encryptedKey, await deriveWrappingKey('Wrap-Pass-0001', salt), iv);
    expect(await roundTrip('after a wrap', pair.publicKey, unwrapped)).toBe('after a wrap');
    await expect(unwrapPrivateKey(encryptedKey, await deriveWrappingKey('Wrong-Pass-0001', salt), iv)).rejects.toThrow();
  }, 30_000);

  it('unwraps a non-extractable session copy by default, which still decrypts', async () => {
    const salt = newSalt();
    const wrapping = await deriveWrappingKey('Wrap-Pass-0002', salt);
    const { encryptedKey, iv } = await wrapPrivateKey(pair.privateKey, wrapping);
    const sessionKey = await unwrapPrivateKey(encryptedKey, wrapping, iv);
    expect(sessionKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', sessionKey)).rejects.toThrow();
    expect(await roundTrip('still readable', pair.publicKey, sessionKey)).toBe('still readable');
    expect((await unwrapPrivateKey(encryptedKey, wrapping, iv, true)).extractable).toBe(true);
  }, 30_000);

  it('exports and imports the public key as a JWK', async () => {
    const jwk = await exportPublicKeyJwk(pair.publicKey);
    expect(JSON.parse(jwk)).toMatchObject({ kty: 'RSA', alg: 'RSA-OAEP-256' });
    expect(await roundTrip('via the JWK', await importPublicKeyJwk(jwk), pair.privateKey)).toBe('via the JWK');
  });

  it('recovers the private key from the recovery key, ignoring line breaks', async () => {
    const recovery = await generateRecoveryKey(pair.privateKey);
    const wrapped = recovery.replace(/(.{64})/g, '$1\n');
    const recovered = await recoverPrivateKey(wrapped);
    expect(await roundTrip('Recovered note 4417', pair.publicKey, recovered)).toBe('Recovered note 4417');
    await expect(recoverPrivateKey('not a key')).rejects.toThrow();
  });

  it('tells whether a private key opens what is sealed to a stored public key', async () => {
    const jwk = await exportPublicKeyJwk(pair.publicKey);
    const own = await recoverPrivateKey(await generateRecoveryKey(pair.privateKey));
    const other = await generateKeyPair();
    const foreign = await recoverPrivateKey(await generateRecoveryKey(other.privateKey));
    expect(await privateKeyOpens(own, jwk)).toBe(true);
    expect(await privateKeyOpens(foreign, jwk)).toBe(false);
    expect(await privateKeyOpens(own, 'not json')).toBe(false);
  }, 60_000);
});
