import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listPickList, type PickListTable } from '@/api/pickLists';
import { queryKeys } from '@/api/queryKeys';

/** Any pick-list table, cached under its own key (queryKeys.pickLists.table). */
export function usePickList<T extends PickListTable>(table: T) {
  return useQuery({ queryKey: queryKeys.pickLists.table(table), queryFn: () => listPickList(table) });
}

export const useContactStatuses = () => usePickList('contact_statuses');
export const useLeadSources = () => usePickList('lead_sources');
export const useOrganizationTypes = () => usePickList('organization_types');
export const useServiceTypes = () => usePickList('service_types');

/** Lookup by key; an unknown key (a list still loading, or a row since removed) is absent. */
export function useByKey<T extends { key: string }>(rows: T[] | undefined): Map<string, T> {
  return useMemo(() => new Map((rows ?? []).map((r) => [r.key, r])), [rows]);
}
