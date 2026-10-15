// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);

import { fake } from './fakeClient';
import { decryptMessage, encryptMessage, generateKeyPair, generateRecoveryKey, importPublicKeyJwk, recoverPrivateKey } from '../crypto';
import {
  AlreadySetUpError,
  changeEncryptionPassword,
  getOwnerKey,
  KeyNotSavedError,
  recoverOwnerKey,
  RecoveryKeyMismatchError,
  setUpOwnerKey,
  unlockOwnerKey,
  WrongPasswordError,
  type OwnerKey,
} from '../ownerKey';

const OWNER = '00000000-0000-4000-8000-000000000001';
const PASSWORD = 'Opening-Pass-2030';
const NEW_PASSWORD = 'Another-Pass-2031';

async function opens(key: CryptoKey, row: OwnerKey): Promise<boolean> {
  const sealed = await encryptMessage('A note from Ada', await importPublicKeyJwk(row.public_key));
  return (await decryptMessage(sealed.ciphertext, sealed.encryptedSessionKey, sealed.iv, key)) === 'A note from Ada';
}

/** Sets up a key through the real path and returns the stored row and the recovery key. */
async function setUp(): Promise<{ row: OwnerKey; recoveryKey: string }> {
  const { recoveryKey } = await setUpOwnerKey(OWNER, PASSWORD);
  const row = await getOwnerKey();
  if (!row) throw new Error('no key row');
  fake.state.calls = [];
  return { row, recoveryKey };
}

const WRAP_COLUMNS = ['encrypted_private_key', 'key_iv', 'key_salt'];

beforeEach(() => {
  fake.reset();
});

describe('setting up the owner key', () => {
  it('sends one INSERT with the public JWK and the wrap, and hands back a working session key', async () => {
    const { recoveryKey, sessionKey } = await setUpOwnerKey(OWNER, PASSWORD);
    const writes = fake.state.calls.filter((c) => c.table === 'organization_keys' && c.op !== 'select');
    expect(writes.map((c) => c.op)).toEqual(['insert']);
    const payload = writes[0].payload as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(['encrypted_private_key', 'key_iv', 'key_salt', 'owner_user_id', 'public_key']);
    expect(payload.owner_user_id).toBe(OWNER);
    expect(payload.key_salt).toHaveLength(24);
    expect(payload.key_iv).toHaveLength(16);
    expect(JSON.parse(payload.public_key)).toMatchObject({ kty: 'RSA', alg: 'RSA-OAEP-256' });
    expect(payload.encrypted_private_key).not.toContain(recoveryKey.slice(0, 40));

    const row = (await getOwnerKey())!;
    expect(sessionKey.extractable).toBe(false);
    expect(await opens(sessionKey, row)).toBe(true);
    expect(await opens(await unlockOwnerKey(row, PASSWORD), row)).toBe(true);
  }, 60_000);

  it('says so plainly when another window set the key up first', async () => {
    fake.state.errors['organization_keys:insert'] = [{ code: '23505', message: 'duplicate key value' }];
    await expect(setUpOwnerKey(OWNER, PASSWORD)).rejects.toBeInstanceOf(AlreadySetUpError);
  }, 60_000);
});

describe('unlocking', () => {
  it('opens with the password and refuses any other', async () => {
    const { row } = await setUp();
    expect(await opens(await unlockOwnerKey(row, PASSWORD), row)).toBe(true);
    await expect(unlockOwnerKey(row, 'Not-The-Pass-1')).rejects.toThrow();
  }, 60_000);
});

describe('changing the encryption password', () => {
  it('re-wraps the same key with a new salt, updating only the wrap columns', async () => {
    const { row } = await setUp();
    const key = await changeEncryptionPassword(row, PASSWORD, NEW_PASSWORD);
    const updates = fake.calls('organization_keys', 'update');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].payload as object).sort()).toEqual(WRAP_COLUMNS);
    expect(updates[0].filters).toEqual([{ type: 'eq', column: 'id', value: row.id }]);
    const after = (await getOwnerKey())!;
    expect(after.public_key).toBe(row.public_key);
    expect(after.key_salt).not.toBe(row.key_salt);
    expect(await opens(key, after)).toBe(true);
    expect(await opens(await unlockOwnerKey(after, NEW_PASSWORD), after)).toBe(true);
    await expect(unlockOwnerKey(after, PASSWORD)).rejects.toThrow();
  }, 60_000);

  it('refuses a wrong current password and writes nothing', async () => {
    const { row } = await setUp();
    await expect(changeEncryptionPassword(row, 'Wrong-Pass-999', NEW_PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    expect(fake.calls('organization_keys', 'update')).toEqual([]);
  }, 60_000);

  it('fails loudly when the update changed no row', async () => {
    const { row } = await setUp();
    fake.state.tables.organization_keys = [];
    await expect(changeEncryptionPassword(row, PASSWORD, NEW_PASSWORD)).rejects.toBeInstanceOf(KeyNotSavedError);
  }, 60_000);
});

describe('recovering with the recovery key', () => {
  it('refuses a key that is not this organization\'s, before writing anything', async () => {
    const { row } = await setUp();
    const stranger = await generateRecoveryKey((await generateKeyPair()).privateKey);
    await expect(recoverOwnerKey(row, stranger, NEW_PASSWORD)).rejects.toBeInstanceOf(RecoveryKeyMismatchError);
    await expect(recoverOwnerKey(row, 'not a recovery key', NEW_PASSWORD)).rejects.toBeInstanceOf(RecoveryKeyMismatchError);
    expect(fake.calls('organization_keys', 'update')).toEqual([]);
  }, 60_000);

  it('refuses a damaged recovery key whose public half still matches, writing nothing', async () => {
    const { row, recoveryKey } = await setUp();
    const jwk = await crypto.subtle.exportKey('jwk', await recoverPrivateKey(recoveryKey));
    const flip = (v: string) => v.slice(0, 5) + (v[5] === 'A' ? 'B' : 'A') + v.slice(6);
    // The private exponent and a CRT part damaged; n and e untouched.
    const damaged = await crypto.subtle.importKey(
      'jwk', { ...jwk, d: flip(jwk.d!), dp: flip(jwk.dp!) }, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
    const damagedJwk = await crypto.subtle.exportKey('jwk', damaged);
    expect([damagedJwk.n, damagedJwk.e]).toEqual([JSON.parse(row.public_key).n, JSON.parse(row.public_key).e]);
    await expect(recoverOwnerKey(row, await generateRecoveryKey(damaged), NEW_PASSWORD)).rejects.toBeInstanceOf(RecoveryKeyMismatchError);
    expect(fake.calls('organization_keys', 'update')).toEqual([]);
  }, 60_000);

  it('re-wraps the matching key under the new password, updating only the wrap', async () => {
    const { row, recoveryKey } = await setUp();
    const key = await recoverOwnerKey(row, recoveryKey, NEW_PASSWORD);
    const updates = fake.calls('organization_keys', 'update');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].payload as object).sort()).toEqual(WRAP_COLUMNS);
    const after = (await getOwnerKey())!;
    expect(after.public_key).toBe(row.public_key);
    expect(key.extractable).toBe(false);
    expect(await opens(key, after)).toBe(true);
    expect(await opens(await unlockOwnerKey(after, NEW_PASSWORD), after)).toBe(true);
  }, 60_000);
});
