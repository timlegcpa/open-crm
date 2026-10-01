import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listContactStatuses, listLeadSources, type ContactStatus, type LeadSource } from '@/api/pickLists';
import { queryKeys } from '@/api/queryKeys';

export function useContactStatuses() {
  return useQuery({ queryKey: queryKeys.pickLists.contactStatuses(), queryFn: listContactStatuses });
}

export function useLeadSources() {
  return useQuery({ queryKey: queryKeys.pickLists.leadSources(), queryFn: listLeadSources });
}

/** Lookup by key; an unknown key (a list still loading, or a row since removed) is absent. */
export function useByKey<T extends ContactStatus | LeadSource>(rows: T[] | undefined): Map<string, T> {
  return useMemo(() => new Map((rows ?? []).map((r) => [r.key, r])), [rows]);
}
