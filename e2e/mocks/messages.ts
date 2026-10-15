import {
  bufferToBase64,
  deriveWrappingKey,
  encryptMessage,
  exportPublicKeyJwk,
  generateKeyPair,
  newSalt,
  wrapPrivateKey,
} from '../../src/features/messages/crypto';
import { ID } from './ids';
import type { Row } from './postgrest';
import type { CallContext, MockSupabase } from './supabase';

/**
 * Secure messages (0004) with real ciphertext: an owner key made by the app's own crypto
 * module (so the format is the one the browser opens), wrapped under a known encryption
 * password, and a client message sealed to it. Made once per worker: the key is RSA-4096.
 */

export const ENCRYPTION_PASSWORD = 'Fixture-Encryption-Pass-1!';
export const CLIENT_MESSAGE = 'Here is the signed agreement. Talk soon!';
export const OWNER_REPLY = 'Thank you, received.';
const KEY_ID = '00000000-0000-4000-8000-000000000701';

interface Material {
  keyRow: Row;
  sealed: { ciphertext: string; encryptedSessionKey: string; iv: string };
}

let material: Promise<Material> | null = null;

function makeMaterial(): Promise<Material> {
  material ??= (async () => {
    const pair = await generateKeyPair();
    const salt = newSalt();
    const wrapping = await deriveWrappingKey(ENCRYPTION_PASSWORD, salt);
    const { encryptedKey, iv } = await wrapPrivateKey(pair.privateKey, wrapping);
    const keyRow = {
      id: KEY_ID,
      public_key: await exportPublicKeyJwk(pair.publicKey),
      encrypted_private_key: encryptedKey,
      key_salt: bufferToBase64(salt),
      key_iv: iv,
    };
    return { keyRow, sealed: await encryptMessage(CLIENT_MESSAGE, pair.publicKey) };
  })();
  return material;
}

/** Adds the owner's key, Ada's conversation and the RPCs that read them. */
export async function withMessages(mock: MockSupabase): Promise<void> {
  const { keyRow, sealed } = await makeMaterial();
  mock.scenario.tables.organization_keys = [{ ...keyRow }];
  mock.scenario.tables.client_messages = [
    {
      id: '00000000-0000-4000-8000-000000000711',
      contact_id: ID.ada,
      sender_id: ID.clientUser,
      sender_role: 'client',
      body: null,
      is_encrypted: true,
      encrypted_body: sealed.ciphertext,
      encrypted_key: sealed.encryptedSessionKey,
      encryption_iv: sealed.iv,
      key_id: KEY_ID,
      read_at: null,
      created_at: '2026-10-09T10:05:00Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000712',
      contact_id: ID.ada,
      sender_id: ID.owner,
      sender_role: 'owner',
      body: 'Could you send the signed agreement when you have a moment?',
      is_encrypted: false,
      encrypted_body: null,
      encrypted_key: null,
      encryption_iv: null,
      key_id: null,
      read_at: '2026-10-09T09:00:00Z',
      created_at: '2026-10-08T16:00:00Z',
    },
  ];
  mock.scenario.rpc.get_org_public_key = { key_id: KEY_ID, public_key: keyRow.public_key };
  mock.scenario.rpc.admin_list_conversations = (_args: Record<string, unknown>, ctx: CallContext) => {
    const rows = ctx.table('client_messages').filter((m) => m.contact_id === ID.ada);
    if (rows.length === 0) return [];
    const last = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    return [
      {
        contact_id: ID.ada,
        full_name: 'Ada Lovelace',
        business_name: 'Acme LLC',
        email: 'ada@example.test',
        last_message_id: last.id,
        last_message_body: last.body,
        last_message_at: last.created_at,
        last_message_sender_role: last.sender_role,
        unread_count: rows.filter((m) => m.sender_role === 'client' && !m.read_at).length,
        message_count: rows.length,
      },
    ];
  };
}
