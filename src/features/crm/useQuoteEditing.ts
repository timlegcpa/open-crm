import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ContactService } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import {
  createQuote,
  deleteQuote,
  getContactStatus,
  listServicesForContact,
  setStatusIfUnchanged,
  updateQuote,
  type NewQuote,
  type QuotePatch,
} from './api';
import { contactPatchForQuoteChange, quoteOpMutationKey } from './lib/quotes';

/**
 * THE quote write path, shared by the Billing tab and the board's card bar. One operation
 * per edit: the row write, then a re-read of the contact's quotes from the server, then the
 * contact patch those quotes imply, all awaited inside one mutation so `busy` spans the
 * whole chain and two edits never derive from the same stale state. The price input is
 * held while `busy` (and while a stage move runs), so no edit starts mid-chain. Every edit for a
 * contact runs under `quoteOpMutationKey`, which the board's stage move waits on.
 */
export function useQuoteEditing(contact: { id: string }) {
  const queryClient = useQueryClient();
  const contactId = contact.id;

  const quoteOp = useMutation({
    mutationKey: quoteOpMutationKey(contactId),
    mutationFn: async (op: () => Promise<unknown>) => {
      await op();
      // Server truth on both sides: the quotes as they now stand and the status as stored,
      // never the cache. The write is compare-and-set on that status, so a stage move that
      // lands in between (to Cold, say) wins and the quote never promotes over it.
      const [serverRows, status] = await Promise.all([listServicesForContact(contactId), getContactStatus(contactId)]);
      const patch = status === null ? null : contactPatchForQuoteChange({ status }, serverRows);
      if (patch?.status && status !== null) await setStatusIfUnchanged(contactId, status, patch.status);
      await queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'The quote was not saved.'));
      // The row write may have landed before the failure: resync.
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    },
  });

  /** Resolves true when the whole chain landed; a failure has already been toasted. */
  const run = useCallback(
    (op: () => Promise<unknown>) => quoteOp.mutateAsync(op).then(() => true, () => false),
    [quoteOp],
  );

  const patchQuote = useCallback((row: Pick<ContactService, 'id'>, patch: QuotePatch) => run(() => updateQuote(row.id, patch)), [run]);
  const addQuote = useCallback(
    (input: Omit<NewQuote, 'contact_id'>) => run(() => createQuote({ ...input, contact_id: contactId })),
    [run, contactId],
  );
  const removeQuote = useCallback((row: Pick<ContactService, 'id'>) => run(() => deleteQuote(row.id)), [run]);

  return { busy: quoteOp.isPending, run, patchQuote, addQuote, removeQuote };
}

export type QuoteEditing = ReturnType<typeof useQuoteEditing>;
