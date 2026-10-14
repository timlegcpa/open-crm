import { getSupabase } from '@/lib/supabase';

/**
 * The owner-editable pick-lists (0002_contacts.sql). Keys never change; labels, colours and
 * order are the owner's. A row with `is_active = false` stays valid on old records but is
 * not offered for new ones. `is_system` rows are the ones the code depends on.
 */

/** A row of `contact_statuses`. The keys are fixed (src/lib/contactStatus.ts). */
export interface ContactStatus {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
}

/** A row of `lead_sources`. */
export interface LeadSource {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
}

/** A row of `organization_types`. A client may read these too, to label its own businesses. */
export interface OrganizationType {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

/** A row of `service_types`. `revenue_family` says whether the service counts toward recurring revenue. */
export interface ServiceType {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  revenue_family: 'recurring' | 'one_time';
  default_cadence: 'monthly' | 'annual' | 'one_time';
}

/** Every pick-list table and its row type. Add a table here and in COLUMNS, and it gets a hook by one line. */
export interface PickListRows {
  contact_statuses: ContactStatus;
  lead_sources: LeadSource;
  organization_types: OrganizationType;
  service_types: ServiceType;
}

export type PickListTable = keyof PickListRows;

const COLUMNS: { [T in PickListTable]: string } = {
  contact_statuses: 'key, label, colour, sort_order',
  lead_sources: 'key, label, colour, sort_order, is_active',
  organization_types: 'key, label, colour, sort_order, is_active, is_system',
  service_types: 'key, label, colour, sort_order, is_active, is_system, revenue_family, default_cadence',
};

/** A whole pick-list in display order (key breaks a tie). The lists are small, so one read. */
export async function listPickList<T extends PickListTable>(table: T): Promise<PickListRows[T][]> {
  const { data, error } = await getSupabase().from(table).select(COLUMNS[table]).order('sort_order').order('key');
  if (error) throw error;
  return (data ?? []) as unknown as PickListRows[T][];
}
