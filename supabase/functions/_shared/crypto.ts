// Encryption at rest: AES-256-GCM through WebCrypto, in the source system's exact wire
// formats, so data written by either can be read by the other and a key rotation can
// recognise every ciphertext it meets.
//
// Keys: DOCUMENT_ENCRYPTION_KEY and PII_ENCRYPTION_KEY, each 32 random bytes in standard
// base64 (decoded with atob; `npm run dev:bootstrap` writes them). Anything that does not
// decode to exactly 32 bytes is refused: AES-GCM would otherwise accept a 16- or 24-byte
// key and encrypt under AES-128 without a word. Both are separate secrets on purpose.
//
// Formats:
//   document   ciphertext = AES-GCM(plaintext) with the 16-byte tag appended (raw
//              bytes, the Storage object); a random 12-byte IV per document, stored
//              base64 in its own column. No version byte: the row's IV column and status
//              say what the object is.
//   pii        0x01 || 12-byte IV || ciphertext+tag, one bytea value. The leading byte is
//              the format version: a future format (a new key id, say) takes 0x02 and
//              readers branch on it. Empty plaintext is stored as empty bytes.
//   pii split  ciphertext+tag and the 12-byte IV in two bytea columns, no version byte
//              (the e-sign signer phone shape). Same key as pii.
// bytea travels through PostgREST as a '\x..' hex string: toByteaHex / fromBytea.
//
// Rotation: GCM authenticates, so decrypting under the wrong key fails rather than
// returning garbage, and a rotation can probe each value with the NEW key first and skip
// what already opens (resumable, idempotent). The source system's rotation script covers
// only its third, token format (base64 of IV || ciphertext, no version byte), which Open
// CRM does not use; its documents and pii values had no rotation script there, and its
// production practice was to rotate and re-authenticate rather than re-encrypt. A rotation
// here re-encrypts each document object under a fresh IV (updating the IV column with
// it) and rewrites each pii value; the formats above are what such a script must read.

const IV_BYTES = 12;
const PII_VERSION = 0x01;

/** A copy only when needed, so WebCrypto gets an ArrayBuffer-backed view. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Import a base64 AES-256 key. Throws unless it decodes to exactly 32 bytes. */
export async function importAesKey(keyB64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(keyB64);
  } catch {
    throw new Error('encryption key is not base64');
  }
  if (raw.length !== 32) throw new Error('encryption key must be 32 bytes');
  return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

async function seal(plaintext: Uint8Array, keyB64: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const key = await importAesKey(keyB64, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, owned(plaintext)));
  return { ciphertext, iv };
}

async function open(ciphertext: Uint8Array, iv: Uint8Array, keyB64: string): Promise<Uint8Array> {
  if (iv.length !== IV_BYTES) throw new Error('IV must be 12 bytes');
  const key = await importAesKey(keyB64, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: owned(iv) }, key, owned(ciphertext)));
}

/** Encrypt a document's bytes. Store `ciphertext` as the object and `iv` (base64) in its row. */
export async function encryptDocument(plaintext: Uint8Array, keyB64: string): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const { ciphertext, iv } = await seal(plaintext, keyB64);
  return { ciphertext, iv: bytesToBase64(iv) };
}

export function decryptDocument(ciphertext: Uint8Array, ivB64: string, keyB64: string): Promise<Uint8Array> {
  return open(ciphertext, base64ToBytes(ivB64), keyB64);
}

/** One bytea value: 0x01 || IV || ciphertext+tag. Empty plaintext gives empty bytes. */
export async function encryptPii(plaintext: string, keyB64: string): Promise<Uint8Array> {
  if (!plaintext) return new Uint8Array(0);
  const { ciphertext, iv } = await seal(new TextEncoder().encode(plaintext), keyB64);
  const out = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  out[0] = PII_VERSION;
  out.set(iv, 1);
  out.set(ciphertext, 1 + IV_BYTES);
  return out;
}

export async function decryptPii(value: Uint8Array, keyB64: string): Promise<string> {
  if (value.length === 0) return '';
  if (value[0] !== PII_VERSION) throw new Error('unknown pii format version');
  const plain = await open(value.subarray(1 + IV_BYTES), value.subarray(1, 1 + IV_BYTES), keyB64);
  return new TextDecoder().decode(plain);
}

/** The two-column shape (ciphertext and IV stored apart, no version byte). */
export async function encryptPiiSplit(plaintext: string, keyB64: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  return await seal(new TextEncoder().encode(plaintext), keyB64);
}

export async function decryptPiiSplit(ciphertext: Uint8Array, iv: Uint8Array, keyB64: string): Promise<string> {
  return new TextDecoder().decode(await open(ciphertext, iv, keyB64));
}

/** The SHA-256 of a string's UTF-8 bytes, as 64 lowercase hex characters (a stored token's hash). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes as unpadded base64url (43 characters): a token safe in a URL. */
export function randomTokenBase64Url(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes to the PostgREST bytea literal, '\x0102..'. */
export function toByteaHex(bytes: Uint8Array): string {
  return '\\x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A bytea value as PostgREST returns it ('\x..' hex) or as bytes. Throws on anything malformed. */
export function fromBytea(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string') throw new Error('bytea value must be a hex string or bytes');
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bytea value is not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
