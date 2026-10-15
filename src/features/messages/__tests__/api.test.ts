// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);

import { fake } from './fakeClient';
import { countUnread, listConversation, listConversations, markClientMessagesRead, sendReply } from '../api';
import { markRepliesRead, sendEncrypted } from '../portalApi';
import { generateKeyPair, exportPublicKeyJwk } from '../crypto';

const CONTACT = '10000000-0000-4000-8000-00000000000a';
const OWNER = '00000000-0000-4000-8000-000000000001';
const CLIENT = '00000000-0000-4000-8000-00000000000a';

function message(id: string, createdAt: string, fields: Record<string, unknown> = {}) {
  return {
    id, contact_id: CONTACT, sender_role: 'client', body: null, is_encrypted: true,
    encrypted_body: 'c'.repeat(24), encrypted_key: 'k'.repeat(684), encryption_iv: 'v'.repeat(16), key_id: 'key-1',
    read_at: null, created_at: createdAt, ...fields,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fake.reset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('reading a conversation', () => {
  it('shows messages by time then id, whatever order the pages arrive in', async () => {
    // Ids out of time order, more than one page of them (keyset pages come back by id).
    const rows = Array.from({ length: 1001 }, (_, i) =>
      message(`00000000-0000-4000-8000-${String(1001 - i).padStart(12, '0')}`, new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString()));
    rows.push(message('00000000-0000-4000-8000-999999999999', rows[0].created_at));
    fake.state.tables.client_messages = rows;
    const list = await listConversation(CONTACT);
    expect(list).toHaveLength(1002);
    expect(fake.calls('client_messages', 'select')).toHaveLength(2);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      expect(a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id)).toBe(true);
    }
  });

  it('parses the inbox the server builds, and refuses a malformed one', async () => {
    const entry = {
      contact_id: CONTACT, full_name: 'Ada Lovelace', business_name: null, email: 'ada@example.com',
      last_message_id: 'm-1', last_message_body: null, last_message_at: '2030-01-01T00:00:00Z',
      last_message_sender_role: 'client', unread_count: 2, message_count: 3,
    };
    fake.state.rpc.admin_list_conversations = () => ({ data: [entry], error: null });
    expect(await listConversations()).toEqual([entry]);
    fake.state.rpc.admin_list_conversations = () => ({ data: [{ ...entry, unread_count: 'two' }], error: null });
    await expect(listConversations()).rejects.toThrow();
  });
});

describe('owner writes', () => {
  it('a reply is plain text, sent as the owner', async () => {
    await sendReply(CONTACT, OWNER, 'See you Tuesday.');
    expect(fake.calls('client_messages', 'insert')[0].payload).toEqual({
      contact_id: CONTACT, sender_id: OWNER, sender_role: 'owner', body: 'See you Tuesday.', is_encrypted: false,
    });
  });

  it('counts unread client messages, overall or for one contact', async () => {
    fake.state.tables.client_messages = [
      message('a', '2030-01-01T00:00:00Z'),
      message('b', '2030-01-01T00:00:01Z', { read_at: '2030-01-02T00:00:00Z' }),
      message('c', '2030-01-01T00:00:02Z', { contact_id: 'other' }),
      message('d', '2030-01-01T00:00:03Z', { sender_role: 'owner' }),
    ];
    expect(await countUnread()).toBe(2);
    expect(await countUnread(CONTACT)).toBe(1);
  });
});

describe('the owner marking messages read', () => {
  it('sends each id once while a call for it is still in flight', async () => {
    let release!: () => void;
    fake.state.holds['client_messages:update'] = new Promise<void>((resolve) => { release = resolve; });
    const first = markClientMessagesRead(['a', 'b']);
    const second = markClientMessagesRead(['b', 'c']);
    release();
    await Promise.all([first, second]);
    const sent = fake.calls('client_messages', 'update').map((c) => c.filters.find((f) => f.type === 'in')?.value);
    expect(sent).toEqual([['a', 'b'], ['c']]);
    // Only unread rows are touched.
    expect(fake.calls('client_messages', 'update')[0].filters).toContainEqual({ type: 'is', column: 'read_at', value: null });
  });

  it('never throws, on an error or a rejection, and frees the ids for a retry', async () => {
    fake.state.errors['client_messages:update'] = [{ message: 'network down' }];
    await expect(markClientMessagesRead(['a'])).resolves.toBeUndefined();
    fake.state.holds['client_messages:update'] = Promise.reject(new Error('offline'));
    await expect(markClientMessagesRead(['a'])).resolves.toBeUndefined();
    delete fake.state.holds['client_messages:update'];
    await markClientMessagesRead(['a']);
    expect(fake.calls('client_messages', 'update')).toHaveLength(2);
  });
});

describe('the client marking replies read', () => {
  it('retries once, then records one activity row with the count', async () => {
    fake.state.errors['client_messages:update'] = [{ message: 'flaky' }];
    expect(await markRepliesRead(['r1', 'r2'], CONTACT, CLIENT)).toBe(true);
    expect(fake.calls('client_messages', 'update')).toHaveLength(2);
    expect(fake.calls('client_activity_log', 'insert').map((c) => c.payload)).toEqual([
      { contact_id: CONTACT, user_id: CLIENT, action: 'message_read', details: { count: 2 } },
    ]);
  });

  it('gives up quietly after a second failure, recording nothing', async () => {
    fake.state.errors['client_messages:update'] = [{ message: 'down' }, { message: 'still down' }];
    await expect(markRepliesRead(['r1'], CONTACT, CLIENT)).resolves.toBe(false);
    expect(fake.calls('client_activity_log', 'insert')).toEqual([]);
  });
});

describe('the client sending', () => {
  it('sends ciphertext only, encrypted to the key it names', async () => {
    const pair = await generateKeyPair();
    const key = { key_id: 'key-7', public_key: await exportPublicKeyJwk(pair.publicKey) };
    const id = await sendEncrypted('Invoice 4417 is attached', key, CONTACT, CLIENT);
    const payload = fake.calls('client_messages', 'insert')[0].payload as Record<string, unknown>;
    expect(id).toMatch(/^00000000-/);
    expect(payload).toMatchObject({ contact_id: CONTACT, sender_id: CLIENT, sender_role: 'client', body: null, is_encrypted: true, key_id: 'key-7' });
    expect(JSON.stringify(payload)).not.toContain('4417');
    expect(payload.encrypted_key).toHaveLength(684);
  }, 60_000);
});
