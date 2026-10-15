import { z } from 'zod';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';
import { getSupabase } from '@/lib/supabase';
import { MESSAGE_COLUMNS, messageSchema, sortMessages, type Message } from './messageRows';

/**
 * The owner's side of secure messages: direct reads and writes under RLS (0004). Nothing
 * here decrypts; a client's message arrives as ciphertext and is opened in the browser.
 * Portal code never imports this module (it has its own, portalApi.ts).
 */

const conversationSchema = z.object({
  contact_id: z.string(),
  full_name: z.string().nullable(),
  business_name: z.string().nullable(),
  email: z.string().nullable(),
  last_message_id: z.string(),
  last_message_body: z.string().nullable(),
  last_message_at: z.string(),
  last_message_sender_role: z.enum(['owner', 'client']),
  unread_count: z.number().int(),
  message_count: z.number().int(),
});

export type Conversation = z.infer<typeof conversationSchema>;

/** Who a conversation is with, for a heading or a row. */
export function conversationName(c: { full_name: string | null; business_name: string | null; email: string | null }): string {
  return c.full_name || c.business_name || c.email || 'Unknown contact';
}

/** One entry per contact with messages, newest activity first (a server aggregate, never capped). */
export async function listConversations(): Promise<Conversation[]> {
  const { data, error } = await getSupabase().rpc('admin_list_conversations');
  if (error) throw error;
  return z.array(conversationSchema).parse(data ?? []);
}

/** A whole conversation, oldest first. */
export async function listConversation(contactId: string): Promise<Message[]> {
  const rows = await fetchAllPaged<Message>((afterId) => {
    let query = getSupabase()
      .from('client_messages')
      .select(MESSAGE_COLUMNS)
      .eq('contact_id', contactId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<Message[]>();
  });
  return sortMessages(z.array(messageSchema).parse(rows));
}

const contactNameSchema = z.object({
  full_name: z.string().nullable(),
  business_name: z.string().nullable(),
  email: z.string().nullable(),
});

/** The name to head a conversation with; null when no such contact is visible. */
export async function getConversationContact(contactId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('contacts')
    .select('full_name, business_name, email')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw error;
  return data ? conversationName(contactNameSchema.parse(data)) : null;
}

/** The owner's reply: plain text by design (see crypto.ts). */
export async function sendReply(contactId: string, senderId: string, body: string): Promise<void> {
  const { error } = await getSupabase().from('client_messages').insert({
    contact_id: contactId,
    sender_id: senderId,
    sender_role: 'owner',
    body,
    is_encrypted: false,
  });
  if (error) throw error;
}

// Module-level, not per call: a second call (a realtime refetch re-running the effect)
// must see the ids a first call is still sending, whichever screen fired it.
const markInFlight = new Set<string>();

/**
 * Marks clients' messages read. Sends each id once while a call for it is in flight, and
 * NEVER throws: the caller fires it from an effect, and a failed read receipt must not
 * break the conversation (the next view retries it).
 */
export async function markClientMessagesRead(ids: readonly string[]): Promise<void> {
  const fresh = ids.filter((id) => !markInFlight.has(id));
  if (fresh.length === 0) return;
  fresh.forEach((id) => markInFlight.add(id));
  try {
    const { error } = await getSupabase()
      .from('client_messages')
      .update({ read_at: new Date().toISOString() })
      .in('id', fresh)
      .is('read_at', null);
    if (error) console.warn('Messages were not marked read:', error.message);
  } catch (err) {
    console.warn('Messages were not marked read:', err);
  } finally {
    fresh.forEach((id) => markInFlight.delete(id));
  }
}

/** Deletes messages for good (one round trip for any number). */
export async function deleteMessages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await getSupabase().from('client_messages').delete().in('id', [...ids]);
  if (error) throw error;
}

/** Clients' messages the owner has not read: all of them, or one contact's. */
export async function countUnread(contactId?: string): Promise<number> {
  let query = getSupabase()
    .from('client_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_role', 'client')
    .is('read_at', null);
  if (contactId) query = query.eq('contact_id', contactId);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}
