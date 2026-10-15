import { z } from 'zod';

/**
 * The row shape both sides read, and the order they show it in. Shared by the owner and
 * portal API modules; it imports nothing that reaches the other side's screens.
 */
export const MESSAGE_COLUMNS =
  'id, contact_id, sender_role, body, is_encrypted, encrypted_body, encrypted_key, encryption_iv, key_id, read_at, created_at';

export const messageSchema = z.object({
  id: z.string(),
  contact_id: z.string(),
  sender_role: z.enum(['owner', 'client']),
  body: z.string().nullable(),
  is_encrypted: z.boolean(),
  encrypted_body: z.string().nullable(),
  encrypted_key: z.string().nullable(),
  encryption_iv: z.string().nullable(),
  key_id: z.string().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export type Message = z.infer<typeof messageSchema>;

/**
 * Oldest first, ties by id. Pages arrive in id order (keyset paging), so the order a
 * conversation reads in is always set here, never taken from the response.
 */
export function sortMessages(rows: readonly Message[]): Message[] {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a.created_at) - Date.parse(b.created_at);
    return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
