import { getSupabase } from '@/lib/supabase';
import { contactDisplayName, isUuid } from '@/api/contacts';

export type RelationshipKind = 'spouse' | 'partner' | 'dependent' | 'business_partner' | 'other';

export const RELATIONSHIP_KINDS: RelationshipKind[] = ['spouse', 'partner', 'dependent', 'business_partner', 'other'];

export const RELATIONSHIP_LABELS: Record<RelationshipKind, string> = {
  spouse: 'Spouse',
  partner: 'Partner',
  dependent: 'Dependent',
  business_partner: 'Business partner',
  other: 'Other',
};

/** A link seen from one contact: `direction` says which side of the stored row it is on. */
export interface HouseholdLink {
  id: string;
  relationship: RelationshipKind;
  /** 'outgoing': this contact recorded the link. 'incoming': the other contact did. */
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherName: string;
}

interface RelationshipRow {
  id: string;
  contact_id: string;
  related_contact_id: string;
  relationship: RelationshipKind;
  created_at: string;
}

/** Every link the contact is on either side of, with the other contact's name. */
export async function listHousehold(contactId: string): Promise<HouseholdLink[]> {
  // The id goes into a PostgREST filter string, so it must be a uuid and nothing else.
  if (!isUuid(contactId)) throw new Error('Not a contact id.');
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('contact_relationships')
    .select('id, contact_id, related_contact_id, relationship, created_at')
    .or(`contact_id.eq.${contactId},related_contact_id.eq.${contactId}`)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as RelationshipRow[];
  if (rows.length === 0) return [];

  const otherIds = [...new Set(rows.map((r) => (r.contact_id === contactId ? r.related_contact_id : r.contact_id)))];
  const { data: people, error: peopleError } = await supabase
    .from('contacts')
    .select('id, full_name, business_name')
    .in('id', otherIds);
  if (peopleError) throw peopleError;
  const names = new Map(
    ((people ?? []) as Array<{ id: string; full_name: string; business_name: string | null }>).map((p) => [
      p.id,
      contactDisplayName(p),
    ]),
  );

  return rows.map((r) => {
    const outgoing = r.contact_id === contactId;
    const otherId = outgoing ? r.related_contact_id : r.contact_id;
    return {
      id: r.id,
      relationship: r.relationship,
      direction: outgoing ? 'outgoing' : 'incoming',
      otherId,
      otherName: names.get(otherId) ?? 'Unnamed contact',
    };
  });
}

export async function addRelationship(input: {
  contactId: string;
  relatedContactId: string;
  relationship: RelationshipKind;
}): Promise<void> {
  if (input.contactId === input.relatedContactId) {
    throw new Error('A contact cannot be linked to itself.');
  }
  const row = {
    contact_id: input.contactId,
    related_contact_id: input.relatedContactId,
    relationship: input.relationship,
  };
  const { error } = await getSupabase().from('contact_relationships').insert(row);
  if (error) throw error;
}

export async function removeRelationship(id: string): Promise<void> {
  const { error } = await getSupabase().from('contact_relationships').delete().eq('id', id);
  if (error) throw error;
}
