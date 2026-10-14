import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CONTACT_STATUSES,
  LEAD_SOURCES,
  listPickList,
  ORGANIZATION_TYPES,
  SERVICE_TYPES,
  type PickListSpec,
} from '@/api/pickLists';
import { queryKeys } from '@/api/queryKeys';

/** Any pick-list, a domain's own included, cached under its table (queryKeys.pickLists.table). */
export function usePickList<Row extends { key: string }>(list: PickListSpec<Row>) {
  return useQuery({ queryKey: queryKeys.pickLists.table(list.table), queryFn: () => listPickList(list) });
}

export const useContactStatuses = () => usePickList(CONTACT_STATUSES);
export const useLeadSources = () => usePickList(LEAD_SOURCES);
export const useOrganizationTypes = () => usePickList(ORGANIZATION_TYPES);
export const useServiceTypes = () => usePickList(SERVICE_TYPES);

/** Lookup by key; an unknown key (a list still loading, or a row since removed) is absent. */
export function useByKey<T extends { key: string }>(rows: T[] | undefined): Map<string, T> {
  return useMemo(() => new Map((rows ?? []).map((r) => [r.key, r])), [rows]);
}
