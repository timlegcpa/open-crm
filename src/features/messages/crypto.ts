/**
 * Browser cryptography for secure messages (Web Crypto, crypto.subtle, throughout):
 * - RSA-OAEP 4096 (SHA-256) for the organization's keypair
 * - AES-256-GCM for message bodies and for wrapping the private key
 * - PBKDF2 (600,000 rounds, SHA-256) to turn the owner's encryption password into the
 *   wrapping key
 *
 * Hybrid encryption: a fresh AES key encrypts each body, and RSA-OAEP encrypts that AES
 * key to the organization's public key, so a message of any length keeps RSA's guarantee.
 *
 * THE MODEL (client_messages, supabase/migrations/0004_messages.sql): a client's message is
 * encrypted in the client's browser and stored as ciphertext only; the owner's reply is
 * plain text by design (clients hold no keypair to encrypt to). Whoever just wrote or
 * decrypted a message keeps the plaintext in memory for that page only: it is never
 * written back to the row and never stored in the browser. The server deletes a message 7
 * days after it is read, so there is no expiry here.
 */

/** The longest message body, in UTF-16 units (the database bounds the ciphertext to match). */
export const MESSAGE_MAX_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** An ArrayBuffer or byte array as base64 (padded). */
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 back to bytes. Throws on text that is not base64. */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// The keypair
// ---------------------------------------------------------------------------

/** A new RSA-OAEP 4096 keypair. Extractable: the private half is wrapped and exported once. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKeyPair>;
}

/** 16 random bytes for PBKDF2. */
export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** The AES-256-GCM key that wraps the private key, derived from the encryption password. */
export async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 600_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** The private key encrypted under the wrapping key, as base64 for the key row. */
export async function wrapPrivateKey(privateKey: CryptoKey, wrappingKey: CryptoKey): Promise<{ encryptedKey: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('pkcs8', privateKey, wrappingKey, { name: 'AES-GCM', iv });
  return { encryptedKey: bufferToBase64(wrapped), iv: bufferToBase64(iv) };
}

/**
 * The private key back from its wrap. Non-extractable unless asked: the copy held for an
 * unlocked session can decrypt but can never be exported from the page. Only a re-wrap (a
 * password change) asks for an extractable one, and keeps it no longer than that.
 * Throws when the password was wrong (the AES-GCM tag does not verify).
 */
export async function unwrapPrivateKey(encryptedKey: string, wrappingKey: CryptoKey, iv: string, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'pkcs8',
    base64ToBuffer(encryptedKey),
    wrappingKey,
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    extractable,
    ['decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SealedMessage {
  ciphertext: string;
  encryptedSessionKey: string;
  iv: string;
}

/** Encrypts `plaintext` to `publicKey`: a fresh AES key for the body, sealed with RSA-OAEP. */
export async function encryptMessage(plaintext: string, publicKey: CryptoKey): Promise<SealedMessage> {
  const sessionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, new TextEncoder().encode(plaintext));
  const raw = await crypto.subtle.exportKey('raw', sessionKey);
  const sealedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
  return { ciphertext: bufferToBase64(body), encryptedSessionKey: bufferToBase64(sealedKey), iv: bufferToBase64(iv) };
}

/** The plaintext of a sealed message. Throws when the key is not the one it was sealed to. */
export async function decryptMessage(ciphertext: string, encryptedSessionKey: string, iv: string, privateKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, base64ToBuffer(encryptedSessionKey));
  const sessionKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuffer(iv) }, sessionKey, base64ToBuffer(ciphertext));
  return new TextDecoder().decode(body);
}

// ---------------------------------------------------------------------------
// The public key as stored (a JWK, JSON text)
// ---------------------------------------------------------------------------

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', publicKey));
}

export async function importPublicKeyJwk(jwk: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
}

// ---------------------------------------------------------------------------
// The recovery key: the private key itself (pkcs8, base64), shown to the owner once
// ---------------------------------------------------------------------------

export async function generateRecoveryKey(privateKey: CryptoKey): Promise<string> {
  return bufferToBase64(await crypto.subtle.exportKey('pkcs8', privateKey));
}

/**
 * The private key from a recovery key. Extractable, so it can be wrapped under a new
 * password. Whitespace is ignored (a key pasted from a note may carry line breaks).
 * Throws on text that is not a private key.
 */
export async function recoverPrivateKey(recoveryKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBuffer(recoveryKey.replace(/\s+/g, '')),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['decrypt'],
  );
}

/**
 * Whether a private key really opens what is sealed to the stored public key: a random
 * challenge is encrypted to the public key and must decrypt to the same bytes. A recovery
 * key is checked with this BEFORE it is wrapped and saved. Comparing the modulus and
 * exponent is not enough: a damaged key (a corrupted private exponent or CRT part) carries
 * the right public half yet decrypts nothing, and saving it would leave every message
 * unreadable.
 */
export async function privateKeyOpens(privateKey: CryptoKey, publicJwk: string): Promise<boolean> {
  try {
    const publicKey = await importPublicKeyJwk(publicJwk);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, challenge);
    const opened = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, sealed));
    return opened.length === challenge.length && opened.every((byte, i) => byte === challenge[i]);
  } catch {
    return false;
  }
}
