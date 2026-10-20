import { queryKeys } from '@/api/queryKeys';

/**
 * The CRM's own query keys. Every one nests under `queryKeys.contacts.all`, so a contact
 * write (which invalidates that prefix) refreshes the organizations, quotes and upsells
 * shown beside it. The roster is its own entry, never shared with the contacts list.
 */
export const crmKeys = {
  organizationRoster: () => [...queryKeys.contacts.all, 'organizations', 'roster'] as const,
  organizations: (contactId: string) => [...queryKeys.contacts.all, 'organizations', contactId] as const,
  upsells: (contactId: string) => [...queryKeys.contacts.all, 'upsells', contactId] as const,
  activity: (contactId: string) => [...queryKeys.contacts.all, 'activity', contactId] as const,
  /** A head-only count of working contacts in these statuses (the bottom bar's figures). */
  count: (statuses: readonly string[]) => [...queryKeys.contacts.all, 'count', ...statuses] as const,
};
