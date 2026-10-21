import { useQuery } from '@tanstack/react-query';
import { countContacts } from '@/features/crm/api';
import { crmKeys } from '@/features/crm/keys';
import type { ShellCountProps } from '@/features/types';
import { CLIENT_LIKE_STATUSES, LEAD_LIKE_STATUSES } from '@/lib/contactStatus';

/**
 * The size of the book in the shell's bottom bar: clients (recurring and one-time, the
 * client panel's Clients list) and open leads (every open stage, the pipeline's lanes before
 * Cold). Archived contacts are off both, as they are off every list. The bar shows on every
 * owner page, so each figure is a head-only count, never the contact list; its key sits
 * under the contacts prefix, so any contact write refreshes it.
 */
function useBookCount(statuses: readonly string[]): number | undefined {
  return useQuery({ queryKey: crmKeys.count(statuses), queryFn: () => countContacts(statuses), staleTime: 5 * 60_000 }).data;
}

export function ClientsCount({ children }: ShellCountProps) {
  return <>{children(useBookCount(CLIENT_LIKE_STATUSES))}</>;
}

export function OpenLeadsCount({ children }: ShellCountProps) {
  return <>{children(useBookCount(LEAD_LIKE_STATUSES))}</>;
}
