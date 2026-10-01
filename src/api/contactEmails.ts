import { getSupabase } from '@/lib/supabase';

export type EmailKind = 'primary' | 'spouse';
export type EmailLabel = 'business' | 'personal' | 'other';

export const EMAIL_LABELS: EmailLabel[] = ['business', 'personal', 'other'];

export interface ContactEmail {
  id: string;
  contact_id: string;
  kind: EmailKind;
  email: string;
  label: EmailLabel;
  is_default: boolean;
  created_at: string;
}

export async function listContactEmails(contactId: string): Promise<ContactEmail[]> {
  const { data, error } = await getSupabase()
    .from('contact_emails')
    .select('id, contact_id, kind, email, label, is_default, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ContactEmail[];
}

export interface NewContactEmail {
  contactId: string;
  kind: EmailKind;
  email: string;
  label: EmailLabel;
}

/**
 * Adds an address as a non-default row. Making it the default is a separate call to
 * `setDefaultContactEmail`, which demotes the old default in the same transaction; an
 * insert with `is_default: true` would collide with the one-default-per-kind index.
 */
export async function addContactEmail(input: NewContactEmail): Promise<string> {
  const row = {
    contact_id: input.contactId,
    kind: input.kind,
    email: input.email,
    label: input.label,
    is_default: false,
  };
  const { data, error } = await getSupabase().from('contact_emails').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Changes an address or its label. The default flag moves only through the RPC. */
export async function updateContactEmail(id: string, fields: { email: string; label: EmailLabel }): Promise<void> {
  const payload = { email: fields.email, label: fields.label };
  const { error } = await getSupabase().from('contact_emails').update(payload).eq('id', id);
  if (error) throw error;
}

export async function deleteContactEmail(id: string): Promise<void> {
  const { error } = await getSupabase().from('contact_emails').delete().eq('id', id);
  if (error) throw error;
}

export async function setDefaultContactEmail(id: string, contactId: string, kind: EmailKind): Promise<void> {
  const { error } = await getSupabase().rpc('contact_emails_set_default', {
    p_id: id,
    p_contact_id: contactId,
    p_kind: kind,
  });
  if (error) throw error;
}
