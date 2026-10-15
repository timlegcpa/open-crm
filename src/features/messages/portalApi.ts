import { z } from 'zod';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { getSupabase } from '@/lib/supabase';
import { encryptMessage, importPublicKeyJwk } from './crypto';
import { MESSAGE_COLUMNS, messageSchema, sortMessages, type Message } from './messageRows';

/**
 * The client's side of secure messages, under RLS (0004): a client reads and writes only
 * its own contact's conversation. Never imports the owner's module (api.ts).
 */

/** The client's conversation, oldest first (RLS scopes it to the client's contact). */
export async function listMyMessages(): Promise<Message[]> {
  const rows = await fetchAllPaged<Message>((afterId) => {
    let query = getSupabase().from('client_messages').select(MESSAGE_COLUMNS).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<Message[]>();
  });
  return sortMessages(z.array(messageSchema).parse(rows));
}

/** The owner's replies the client has not read. */
export async function countUnreadReplies(): Promise<number> {
  const { count, error } = await getSupabase()
    .from('client_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_role', 'owner')
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Marks the owner's replies read, then records one activity row for the batch. A read
 * receipt the client is not waiting on: one retry absorbs a single flaky request, and a
 * second failure is logged, never thrown into the page. The activity row is best effort.
 * Resolves to whether the replies were marked, so the page can try again later.
 */
export async function markRepliesRead(ids: readonly string[], contactId: string, userId: string): Promise<boolean> {
  if (ids.length === 0) return true;
  const update = () =>
    getSupabase()
      .from('client_messages')
      .update({ read_at: new Date().toISOString() })
      .in('id', [...ids])
      .is('read_at', null);
  try {
    let { error } = await update();
    if (error) ({ error } = await update());
    if (error) {
      console.warn('Replies were not marked read:', error.message);
      return false;
    }
    const logged = await getSupabase()
      .from('client_activity_log')
      .insert({ contact_id: contactId, user_id: userId, action: 'message_read', details: { count: ids.length } });
    if (logged.error) console.warn('The read was not recorded:', logged.error.message);
    return true;
  } catch (err) {
    console.warn('Replies were not marked read:', err);
    return false;
  }
}

const publicKeySchema = z.object({ key_id: z.string(), public_key: z.string() }).nullable();

export type OrgPublicKey = NonNullable<z.infer<typeof publicKeySchema>>;

/** The key messages are encrypted to; null until the owner has set up secure messages. */
export async function getOrgPublicKey(): Promise<OrgPublicKey | null> {
  const { data, error } = await getSupabase().rpc('get_org_public_key');
  if (error) throw error;
  return publicKeySchema.parse(data ?? null);
}

/**
 * Encrypts `plaintext` in this browser to the organization's key and sends only the
 * ciphertext. Returns the new message's id, so the page can show the text it just sent.
 */
export async function sendEncrypted(plaintext: string, key: OrgPublicKey, contactId: string, userId: string): Promise<string> {
  const sealed = await encryptMessage(plaintext, await importPublicKeyJwk(key.public_key));
  const { data, error } = await getSupabase()
    .from('client_messages')
    .insert({
      contact_id: contactId,
      sender_id: userId,
      sender_role: 'client',
      body: null,
      is_encrypted: true,
      encrypted_body: sealed.ciphertext,
      encrypted_key: sealed.encryptedSessionKey,
      encryption_iv: sealed.iv,
      key_id: key.key_id,
    })
    .select('id')
    .single();
  if (error) throw error;
  return z.object({ id: z.string() }).parse(data).id;
}

/** Whether this session is the owner viewing as the client (read-only). */
export async function isViewAsClient(): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('is_view_as_client');
  if (error) throw error;
  return data === true;
}

/** The organization's display name, for the page's wording. */
export async function getOrgName(): Promise<string | null> {
  const { data, error } = await getSupabase().rpc('get_org_branding');
  if (error) throw error;
  const name = (data as { display_name?: unknown } | null)?.display_name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}
