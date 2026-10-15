import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queryKeys';
import { updateContact } from '@/api/contacts';
import { useByKey } from '@/hooks/usePickLists';
import { aggregateUpsells } from '@/lib/revenue';
import { getErrorMessage } from '@/lib/errors';
import { toast } from '@/components/ui/sonner';
import {
  createMonthlyGoal,
  joinQuotes,
  listContactStatuses,
  listLeadSources,
  listMarketingContacts,
  listMonthlyGoals,
  listOpenUpsells,
  listQuotes,
  listServiceTypes,
  marketingKeys,
  updateMonthlyGoal,
  type MarketingContactRow,
  type MonthlyGoalPatch,
  type NewMonthlyGoal,
} from './api';

/** A contact field the right bar edits, each through the record's own write (updateContact). */
export type ContactField = 'source' | 'status' | 'client_since';

/**
 * Everything the marketing page reads, and its writes. Nothing is computed until EVERY read
 * has succeeded: a figure drawn from a read still loading, or one that failed, would read as
 * a real zero. The page shows the read's own state instead.
 *
 * The three contact-side reads are invalidated together (they share the `contacts` prefix),
 * so an upsell is never summed against a contact list that no longer holds its contact. That
 * is why the upsell rollup can use the shared rule as it stands (an upsell whose contact is
 * not in the map still counts, a guard for reads landing in different orders).
 */
export function useMarketingData() {
  const queryClient = useQueryClient();
  const contactsQ = useQuery({ queryKey: marketingKeys.contacts, queryFn: listMarketingContacts });
  const quotesQ = useQuery({ queryKey: marketingKeys.quotes, queryFn: listQuotes });
  const upsellsQ = useQuery({ queryKey: marketingKeys.upsells, queryFn: listOpenUpsells });
  const goalsQ = useQuery({ queryKey: marketingKeys.goals, queryFn: listMonthlyGoals });
  const sourcesQ = useQuery({ queryKey: marketingKeys.pickList('lead_sources'), queryFn: listLeadSources });
  const statusesQ = useQuery({ queryKey: marketingKeys.pickList('contact_statuses'), queryFn: listContactStatuses });
  const serviceTypesQ = useQuery({ queryKey: marketingKeys.pickList('service_types'), queryFn: listServiceTypes });

  const all = [contactsQ, quotesQ, upsellsQ, goalsQ, sourcesQ, statusesQ, serviceTypesQ];
  const error = all.find((q) => q.isError)?.error ?? null;
  const ready = all.every((q) => q.isSuccess);

  const contacts = useMemo(
    () => (contactsQ.data && quotesQ.data ? joinQuotes(contactsQ.data, quotesQ.data) : []),
    [contactsQ.data, quotesQ.data],
  );
  const upsells = useMemo(() => {
    if (!upsellsQ.data) return { proposedMRR: 0, proposedARR: 0, proposedAnnual: 0, proposedOneTime: 0 };
    return aggregateUpsells(upsellsQ.data, new Map(contacts.map((c) => [c.id, c])));
  }, [upsellsQ.data, contacts]);

  const sourcesByKey = useByKey(sourcesQ.data);
  const statusesByKey = useByKey(statusesQ.data);

  // Optimistic: the list (and every figure drawn from it) moves at once, and goes back if
  // the write fails. The invalidate then reconciles with what the database stored.
  const updateField = useMutation({
    mutationFn: ({ id, field, value }: { id: string; field: ContactField; value: string | null }) =>
      updateContact(id, { [field]: value }),
    onMutate: async ({ id, field, value }) => {
      await queryClient.cancelQueries({ queryKey: marketingKeys.contacts });
      const previous = queryClient.getQueryData<MarketingContactRow[]>(marketingKeys.contacts);
      queryClient.setQueryData<MarketingContactRow[]>(marketingKeys.contacts, (old) =>
        old?.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
      );
      return { previous };
    },
    // The failure is reported HERE, not by the row that made the edit: an optimistic change
    // can move the contact out of the open list, and the row (with any error it would show)
    // is gone by the time the write fails.
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(marketingKeys.contacts, context.previous);
      toast.error(`The change was not saved: ${getErrorMessage(err, 'an unexpected error')}.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });

  const createGoal = useMutation({
    mutationFn: (input: NewMonthlyGoal) => createMonthlyGoal(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: marketingKeys.goals }),
  });
  const updateGoal = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MonthlyGoalPatch }) => updateMonthlyGoal(id, patch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: marketingKeys.goals }),
  });

  return {
    ready,
    error,
    contacts,
    upsells,
    goals: goalsQ.data ?? [],
    sources: sourcesQ.data ?? [],
    sourcesByKey,
    statuses: statusesQ.data ?? [],
    statusesByKey,
    serviceTypes: serviceTypesQ.data ?? [],
    updateField,
    createGoal,
    updateGoal,
  };
}

export type MarketingData = ReturnType<typeof useMarketingData>;
