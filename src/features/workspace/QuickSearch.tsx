import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { contactDisplayName, isArchived } from '@/api/contacts';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { useContacts, useOrganizationsByContact } from '@/features/crm/hooks';
import { matchesCrmSearch } from '@/features/crm/lib/board';

/** How many matches the list draws; the rest are counted, never dropped in silence. */
const SHOWN = 20;

/**
 * The rail's search, floated beside the rail where the client panel is not on screen (a
 * settings page, an envelope). Type and the matches appear from the first character, with
 * the same matcher as the panel (name, email, phone, business); an empty box lists nothing.
 * Enter or a click opens the record. It holds no state of its own beyond the box: the
 * popover unmounts it on close, so a dismissed search is a cleared one.
 */
export function QuickSearch({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const contacts = useContacts();
  const orgsByContact = useOrganizationsByContact();
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);

  const matches = useMemo(() => {
    if (query.trim() === '') return [];
    return (contacts.data ?? []).filter((c) => !isArchived(c) && matchesCrmSearch(c, orgsByContact.get(c.id) ?? [], query));
  }, [contacts.data, orgsByContact, query]);

  const open = (contactId: string) => {
    onDone();
    navigate(links.contact(contactId));
  };

  return (
    <Command shouldFilter={false} label="Find a contact">
      <CommandInput autoFocus aria-label="Find a contact" placeholder="Name, email, phone or business" value={query} onValueChange={setQuery} />
      {query.trim() !== '' && (
        <CommandList className="max-h-[320px]">
          <CommandEmpty>{contacts.isPending ? 'Loading...' : 'No matches.'}</CommandEmpty>
          {matches.length > 0 && (
            <CommandGroup heading="Contacts">
              {matches.slice(0, SHOWN).map((c) => {
                const business = orgsByContact.get(c.id)?.[0]?.name ?? c.business_name;
                return (
                  <CommandItem key={c.id} value={c.id} onSelect={() => open(c.id)} className="text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{contactDisplayName(c)}</span>
                    {business && <span className="max-w-[40%] truncate text-[12px] text-muted-foreground">{business}</span>}
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                      {statusByKey.get(c.status)?.label ?? c.status}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {matches.length > SHOWN && <p className="px-3 py-2 text-[12px] text-muted-foreground">{matches.length - SHOWN} more, keep typing</p>}
        </CommandList>
      )}
    </Command>
  );
}
