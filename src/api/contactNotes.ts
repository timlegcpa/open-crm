import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE } from '@/lib/pagedFetch';

export type NoteKind = 'note' | 'call' | 'email' | 'meeting';

export const NOTE_KINDS: NoteKind[] = ['note', 'call', 'email', 'meeting'];

/**
 * One note on a contact. A note can be corrected (its text and its kind) and deleted, but
 * `source` is never writable, by grant (0017) and here: a note the connector or a lead
 * form wrote can never be relabelled as the owner's.
 */
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

/** Correct a note's text, its kind, or both. Only these two columns are ever sent. */
export async function updateContactNote(id: string, patch: { body?: string; kind?: NoteKind }): Promise<void> {
  const update: { body?: string; kind?: NoteKind } = {};
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.kind !== undefined) update.kind = patch.kind;
  const { data, error } = await getSupabase().from('contact_notes').update(update).eq('id', id).select('id');
  if (error) throw error;
  // Zero rows is a note deleted meanwhile (or never readable): say so, never a silent success.
  if (!data || data.length === 0) throw new Error('That note no longer exists.');
}

/** Delete one note. A hard delete: there is no archive for notes. */
export async function deleteContactNote(id: string): Promise<void> {
  const { error } = await getSupabase().from('contact_notes').delete().eq('id', id);
  if (error) throw error;
}

/** A note as the pipeline cards read it. */
export interface LeadNoteRow {
  id: string;
  contact_id: string;
  body: string;
  created_at: string;
}

/**
 * Every note of the working contacts in `statuses` (archived ones left out), NEWEST FIRST:
 * the pipeline cards show each person's first. Joined on status rather than keyed by a list
 * of contact ids, so the request stays short however many leads there are. Read in pages
 * by id, then ordered by date here.
 */
export async function listNotesForStatuses(statuses: readonly string[]): Promise<LeadNoteRow[]> {
  const rows = await fetchAllPaged<LeadNoteRow>((afterId) => {
    let query = getSupabase()
      .from('contact_notes')
      .select('id, contact_id, body, created_at, contacts!inner(status, archived_at)')
      .in('contacts.status', [...statuses])
      .is('contacts.archived_at', null)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query.returns<LeadNoteRow[]>();
  });
  return rows
    .map(({ id, contact_id, body, created_at }) => ({ id, contact_id, body, created_at }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
