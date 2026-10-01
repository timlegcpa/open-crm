import { getSupabase } from '@/lib/supabase';

/** A row of `contact_statuses`. The keys are fixed; labels, colours and order are the owner's. */
export interface ContactStatus {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
}

/** A row of `lead_sources`. Inactive sources stay valid on old contacts but are not offered for new ones. */
export interface LeadSource {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
}

export async function listContactStatuses(): Promise<ContactStatus[]> {
  const { data, error } = await getSupabase()
    .from('contact_statuses')
    .select('key, label, colour, sort_order')
    .order('sort_order')
    .order('key');
  if (error) throw error;
  return (data ?? []) as ContactStatus[];
}

export async function listLeadSources(): Promise<LeadSource[]> {
  const { data, error } = await getSupabase()
    .from('lead_sources')
    .select('key, label, colour, sort_order, is_active')
    .order('sort_order')
    .order('key');
  if (error) throw error;
  return (data ?? []) as LeadSource[];
}
