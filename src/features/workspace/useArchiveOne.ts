import { useState } from 'react';
import { contactDisplayName, type Contact } from '@/api/contacts';
import { useSetArchived } from '@/features/crm/hooks';

/**
 * Archive or restore one contact from a row, a card or the Archived dialog. One write per
 * contact at a time: a second click while the first is saving does nothing, and `pending`
 * says which rows to disable.
 */
export function useArchiveOne() {
  const setArchived = useSetArchived();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const archiveOne = async (contact: Contact, archive: boolean) => {
    if (pending.has(contact.id)) return;
    setPending((prev) => new Set(prev).add(contact.id));
    try {
      await setArchived.run([contact.id], archive, contactDisplayName(contact));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(contact.id);
        return next;
      });
    }
  };

  return { archiveOne, pending, setArchived };
}
