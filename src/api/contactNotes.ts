import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';

export type NoteKind = 'note' | 'call' | 'email' | 'meeting';

export const NOTE_KINDS: NoteKind[] = ['note', 'call', 'email', 'meeting'];

/** Notes are append-only: there is no update or delete, by grant and here. */
export interface ContactNote {
  id: string;
  contact_id: string;
  body: string;
  kind: NoteKind;
  source: string;
  created_at: string;
}

/** Every note, newest first. Notes only ever grow, so they are read in pages. */
export async function listContactNotes(contactId: string): Promise<ContactNote[]> {
  const notes = await fetchAllPaged<ContactNote>((afterId) => {
    let query = getSupabase()
      .from('contact_notes')
      .select('id, contact_id, body, kind, source, created_at')
      .eq('contact_id', contactId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<ContactNote[]>();
  });
  return notes.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function addContactNote(contactId: string, body: string, kind: NoteKind = 'note'): Promise<void> {
  const row = { contact_id: contactId, body, kind, source: 'owner' };
  const { error } = await getSupabase().from('contact_notes').insert(row);
  if (error) throw error;
}
