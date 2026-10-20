import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bulkSetArchived, listContacts, updateContact, type BulkStatusResult, type Contact, type ContactPatch, type ContactPatchColumn } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { listOrganizationRoster, type RosterOrganization } from './api';
import { crmKeys } from './keys';

/**
 * Every contact with its quotes: the one list the index, the board, the table, the record
 * and every picker read (the picker shares this exact cache entry).
 */
export function useContacts() {
  return useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts, staleTime: 2 * 60_000 });
}

/** One contact, found in the list (null while loading or when no such contact exists). */
export function useContact(id: string) {
  const contacts = useContacts();
  const contact = useMemo(() => contacts.data?.find((c) => c.id === id) ?? null, [contacts.data, id]);
  return { contacts, contact };
}

/** Every organization, for business names, search and the CSV. */
export function useOrganizationRoster() {
  return useQuery({ queryKey: crmKeys.organizationRoster(), queryFn: listOrganizationRoster, staleTime: 2 * 60_000 });
}

/** Organizations by contact, for a row's business and the widened search. */
export function useOrganizationsByContact(): Map<string, RosterOrganization[]> {
  const roster = useOrganizationRoster();
  return useMemo(() => {
    const map = new Map<string, RosterOrganization[]>();
    for (const o of roster.data ?? []) {
      const list = map.get(o.contact_id) ?? [];
      list.push(o);
      map.set(o.contact_id, list);
    }
    return map;
  }, [roster.data]);
}

/** Puts a saved contact row into the cached list in place. */
export function mergeContact(rows: Contact[] | undefined, saved: Contact): Contact[] | undefined {
  return rows?.map((c) => (c.id === saved.id ? saved : c));
}

/**
 * The key an in-place field save for one contact runs under. The record's quote editors
 * wait on it (a quote save re-derives the status from the one it read, so it must not
 * start while the owner's own status change is saving), as the status field waits on
 * quoteOpMutationKey: each holds while the other runs.
 */
export const contactFieldMutationKey = (contactId: string) => ['contact-field-save', contactId] as const;

/**
 * A contact write. The returned row (quotes included) is merged into the cached list at
 * once, then the whole contacts prefix is refetched. On failure the prefix is refetched too,
 * because a write the client saw fail may still have landed.
 */
export function useUpdateContact(mutationKey?: readonly unknown[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey,
    mutationFn: ({ id, patch }: { id: string; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: (saved) => {
      queryClient.setQueryData<Contact[]>(queryKeys.contacts.list(), (rows) => mergeContact(rows, saved));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });
}

/**
 * The save every in-place contact field uses: a field and its value become one patch.
 * Rejects when the save
 * failed, after a toast says so, so the field shows no "Saved".
 */
export function useContactFieldSave(contact: Pick<Contact, 'id'> | null) {
  const update = useUpdateContact(contact ? contactFieldMutationKey(contact.id) : undefined);
  return useCallback(
    (field: ContactPatchColumn) => async (value: string | number | null) => {
      if (!contact) return;
      const text = value == null ? null : String(value);
      // A status change is the status alone: the database stamps client_since (see statusChangePatch).
      const patch: ContactPatch = { [field]: text };
      try {
        await update.mutateAsync({ id: contact.id, patch });
      } catch (err) {
        toast.error(getErrorMessage(err, 'The change was not saved.'));
        throw err;
      }
    },
    [contact, update],
  );
}

/**
 * Archive or restore contacts: the one write behind the card, the row, the bulk bar, the
 * record and the archived dialog. Resolves to the result (never rejects): the ids that did
 * not land are in `failedIds`, so a bulk caller keeps them selected for a retry. The toast
 * is the receipt; an archive offers Undo. The whole contacts prefix is refetched either
 * way, because a write the browser saw fail may still have landed.
 */
export function useSetArchived() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ ids, archived }: { ids: readonly string[]; archived: boolean }) => bulkSetArchived(ids, archived),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });
  const { mutateAsync } = mutation;
  const run = useCallback(
    async (ids: readonly string[], archived: boolean, name?: string): Promise<BulkStatusResult> => {
      let result: BulkStatusResult;
      try {
        result = await mutateAsync({ ids, archived });
      } catch (err) {
        result = { requested: ids.length, updated: 0, failedIds: [...ids], error: getErrorMessage(err, 'The change was not saved.') };
      }
      const done = archived ? 'archived' : 'restored';
      if (result.error) {
        toast.error(`${result.updated} of ${result.requested} contacts ${done}. ${result.error}`);
      } else if (archived) {
        const saved = ids.filter((id) => !result.failedIds.includes(id));
        toast.success(name ? `${name} archived. The record is kept.` : `${result.updated} contacts archived. Their records are kept.`, {
          action: { label: 'Undo', onClick: () => void run(saved, false, name) },
        });
      } else {
        toast.success(name ? `${name} restored.` : `${result.updated} contacts restored.`);
      }
      return result;
    },
    [mutateAsync],
  );
  return { run, pending: mutation.isPending };
}
