import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  base64ToBuffer,
  bufferToBase64,
  deriveWrappingKey,
  exportPublicKeyJwk,
  generateKeyPair,
  generateRecoveryKey,
  newSalt,
  privateKeyOpens,
  recoverPrivateKey,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './crypto';

/**
 * The owner's message key (organization_keys, 0004): set up once with an INSERT, then
 * only ever re-wrapped with an UPDATE of the wrap columns, by a password change or a
 * recovery. The public half and the key id never change, so every message stays readable
 * and every client's cached public key stays right. Each write is audited by a trigger.
 */

const ownerKeySchema = z.object({
  id: z.string(),
  public_key: z.string(),
  encrypted_private_key: z.string(),
  key_salt: z.string(),
  key_iv: z.string(),
});

export type OwnerKey = z.infer<typeof ownerKeySchema>;

/** The owner's key row, or null before setup. */
export async function getOwnerKey(): Promise<OwnerKey | null> {
  const { data, error } = await getSupabase()
    .from('organization_keys')
    .select('id, public_key, encrypted_private_key, key_salt, key_iv')
    .maybeSingle();
  if (error) throw error;
  return data ? ownerKeySchema.parse(data) : null;
}

interface Wrap {
  encrypted_private_key: string;
  key_salt: string;
  key_iv: string;
}

/** The private key wrapped under `password` with a fresh salt, plus the wrapping key used. */
async function wrapUnder(privateKey: CryptoKey, password: string): Promise<{ wrap: Wrap; wrappingKey: CryptoKey }> {
  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(password, salt);
  const { encryptedKey, iv } = await wrapPrivateKey(privateKey, wrappingKey);
  return { wrap: { encrypted_private_key: encryptedKey, key_salt: bufferToBase64(salt), key_iv: iv }, wrappingKey };
}

/** Raised when the key row is gone or not the owner's (a re-wrap that changed nothing). */
export class KeyNotSavedError extends Error {
  constructor() {
    super('Your message key could not be updated. Reload the page and try again.');
    this.name = 'KeyNotSavedError';
  }
}

async function saveWrap(keyId: string, wrap: Wrap): Promise<void> {
  const { data, error } = await getSupabase().from('organization_keys').update(wrap).eq('id', keyId).select('id');
  if (error) throw error;
  if (!data || data.length !== 1) throw new KeyNotSavedError();
}

/** A non-extractable copy of the private key, for the unlocked session. */
function sessionCopy(wrap: Wrap, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return unwrapPrivateKey(wrap.encrypted_private_key, wrappingKey, wrap.key_iv, false);
}

export interface SetupResult {
  /** Shown to the owner once; it is the private key itself. */
  recoveryKey: string;
  /** The unlocked key, to hold once the recovery key has been put away. */
  sessionKey: CryptoKey;
}

/** Raised when another window set the key up first (the owner has one key, ever). */
export class AlreadySetUpError extends Error {
  constructor() {
    super('Secure messages were already set up, in another window. Reload the page to unlock them.');
    this.name = 'AlreadySetUpError';
  }
}

/**
 * First run: a new keypair, its private half wrapped under `password`, saved with an
 * INSERT (never an upsert: a second window must not replace a key messages may already be
 * encrypted to).
 */
export async function setUpOwnerKey(ownerUserId: string, password: string): Promise<SetupResult> {
  const { publicKey, privateKey } = await generateKeyPair();
  const { wrap, wrappingKey } = await wrapUnder(privateKey, password);
  const recoveryKey = await generateRecoveryKey(privateKey);
  const { error } = await getSupabase()
    .from('organization_keys')
    .insert({ owner_user_id: ownerUserId, public_key: await exportPublicKeyJwk(publicKey), ...wrap });
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new AlreadySetUpError();
    throw error;
  }
  return { recoveryKey, sessionKey: await sessionCopy(wrap, wrappingKey) };
}

/** The private key for this session. Throws when the password is wrong. */
export async function unlockOwnerKey(key: OwnerKey, password: string): Promise<CryptoKey> {
  const wrappingKey = await deriveWrappingKey(password, new Uint8Array(base64ToBuffer(key.key_salt)));
  return unwrapPrivateKey(key.encrypted_private_key, wrappingKey, key.key_iv, false);
}

/** Raised when the current encryption password does not open the key. */
export class WrongPasswordError extends Error {
  constructor() {
    super('The current encryption password is not right.');
    this.name = 'WrongPasswordError';
  }
}

/** Re-wraps the same private key under a new password. Returns the unlocked key. */
export async function changeEncryptionPassword(key: OwnerKey, currentPassword: string, newPassword: string): Promise<CryptoKey> {
  let privateKey: CryptoKey;
  try {
    const oldWrapping = await deriveWrappingKey(currentPassword, new Uint8Array(base64ToBuffer(key.key_salt)));
    privateKey = await unwrapPrivateKey(key.encrypted_private_key, oldWrapping, key.key_iv, true);
  } catch {
    throw new WrongPasswordError();
  }
  const { wrap, wrappingKey } = await wrapUnder(privateKey, newPassword);
  await saveWrap(key.id, wrap);
  return sessionCopy(wrap, wrappingKey);
}

/** Raised when a recovery key is not a key, or not this organization's. Nothing was saved. */
export class RecoveryKeyMismatchError extends Error {
  constructor() {
    super('That recovery key does not belong to this message key. Nothing was changed.');
    this.name = 'RecoveryKeyMismatchError';
  }
}

/**
 * A forgotten password: the recovery key IS the private key. It is proven to be the
 * private half of the stored public key BEFORE anything is written, then re-wrapped under
 * the new password. Returns the unlocked key.
 */
export async function recoverOwnerKey(key: OwnerKey, recoveryKey: string, newPassword: string): Promise<CryptoKey> {
  let privateKey: CryptoKey;
  try {
    privateKey = await recoverPrivateKey(recoveryKey);
  } catch {
    throw new RecoveryKeyMismatchError();
  }
  if (!(await privateKeyOpens(privateKey, key.public_key))) throw new RecoveryKeyMismatchError();
  const { wrap, wrappingKey } = await wrapUnder(privateKey, newPassword);
  await saveWrap(key.id, wrap);
  return sessionCopy(wrap, wrappingKey);
}
