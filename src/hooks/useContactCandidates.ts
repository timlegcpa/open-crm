import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contactDisplayName, isArchived, listContacts, type ContactListRow } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { matchesContactSearch } from '@/lib/contactSearch';
import { isClientLike } from '@/lib/contactStatus';

/** One row a contact picker offers. */
export interface ContactCandidate {
  id: string;
  /** contactDisplayName: a business-only contact shows its business, never a blank. */
  name: string;
  /** The second line: the business when the name is a person's, else the email. */
  detail: string | null;
  status: string;
  /** A client or one-time client; pickers group these first. */
  isClient: boolean;
}

export function toCandidate(c: ContactListRow): ContactCandidate {
  return {
    id: c.id,
    name: contactDisplayName(c),
    detail: (c.full_name && c.business_name) || c.email || null,
    status: c.status,
    isClient: isClientLike(c.status),
  };
}

/** Clients first, then by name; the id breaks a tie so the order never shuffles. */
function byClientThenName(a: ContactCandidate, b: ContactCandidate): number {
  if (a.isClient !== b.isClient) return a.isClient ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Every contact matching `query` (the contacts list's own search rule), as picker rows. It
 * reads the contacts list's query, so the list and every picker share one cache entry, and
 * it fetches only while `enabled` (a popover that is open): a screen that never shows a
 * picker pays nothing for it. Every contact is offered, a brand-new lead included, except an
 * archived one: archiving takes a contact off every working list (isArchived).
 */
export function useContactCandidates(query: string, enabled: boolean) {
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts, enabled });
  const candidates = useMemo(
    () =>
      (contacts.data ?? [])
        .filter((c) => !isArchived(c) && matchesContactSearch(c, query))
        .map(toCandidate)
        .sort(byClientThenName),
    [contacts.data, query],
  );
  return { contacts, candidates };
}
