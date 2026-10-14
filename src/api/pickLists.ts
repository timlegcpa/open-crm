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

/**
 * One pick-list: its table, the columns to read and the row type they make. A domain declares
 * its own lists beside its own code (`definePickList<StageRow>('board_stages', '...')`) and
 * passes them to usePickList; nothing here changes when a list is added.
 */
export interface PickListSpec<Row extends { key: string }> {
  readonly table: string;
  readonly columns: string;
  /** Type only: carries Row; never set. */
  readonly row?: Row;
}

export function definePickList<Row extends { key: string }>(table: string, columns: string): PickListSpec<Row> {
  return { table, columns };
}

export const CONTACT_STATUSES = definePickList<ContactStatus>('contact_statuses', 'key, label, colour, sort_order');
export const LEAD_SOURCES = definePickList<LeadSource>('lead_sources', 'key, label, colour, sort_order, is_active');
export const ORGANIZATION_TYPES = definePickList<OrganizationType>(
  'organization_types',
  'key, label, colour, sort_order, is_active, is_system',
);
export const SERVICE_TYPES = definePickList<ServiceType>(
  'service_types',
  'key, label, colour, sort_order, is_active, is_system, revenue_family, default_cadence',
);

/** A whole pick-list in display order (key breaks a tie). The lists are small, so one read. */
export async function listPickList<Row extends { key: string }>(list: PickListSpec<Row>): Promise<Row[]> {
  const { data, error } = await getSupabase().from(list.table).select(list.columns).order('sort_order').order('key');
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}
