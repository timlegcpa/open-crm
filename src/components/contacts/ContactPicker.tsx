import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useContactCandidates, type ContactCandidate } from '@/hooks/useContactCandidates';
import { cn } from '@/lib/utils';

/**
 * THE contact picker: a popover search over every contact. Any feature that needs "choose a
 * contact" uses this (or useContactCandidates for an inline field), so every picker matches
 * the way the contacts list searches and names a contact the same way.
 *
 *   <ContactPicker grouped onSelect={(c) => setContactId(c.id)}>
 *     <Button variant="outline" size="sm">Choose a contact</Button>
 *   </ContactPicker>
 *
 * Filtering is the shared search rule, not cmdk's fuzzy matcher, so cmdk's own filter is off.
 */
export function ContactPicker({
  onSelect,
  grouped = false,
  selectedId,
  contentClassName,
  children,
  open: openProp,
  onOpenChange,
}: {
  onSelect: (candidate: ContactCandidate) => void;
  /** Clients under one heading, everyone else under a second. */
  grouped?: boolean;
  /** Draws a tick column; the matching row is ticked, null ticks none. */
  selectedId?: string | null;
  contentClassName?: string;
  /** The trigger. Give it an accessible name. */
  children: ReactNode;
  /** Controlled open, for a caller that opens the picker without a click. Both or neither. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [query, setQuery] = useState('');
  const { contacts, candidates } = useContactCandidates(query, open);

  const groups: Array<[string | null, ContactCandidate[]]> = grouped
    ? [
        ['Clients', candidates.filter((c) => c.isClient)],
        ['Everyone else', candidates.filter((c) => !c.isClient)],
      ]
    : [[null, candidates]];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className={cn('w-72 p-0', contentClassName)} align="start">
        {/* cmdk names its input from `label` (aria-labelledby), which wins over an aria-label. */}
        <Command shouldFilter={false} label="Search contacts">
          <CommandInput
            placeholder="Search name, email, phone or business"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {contacts.isPending ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">Loading contacts...</p>
            ) : contacts.isError ? (
              <p role="alert" className="px-3 py-2 text-[13px] text-destructive">Could not load contacts.</p>
            ) : (
              <>
                <CommandEmpty>No contacts match.</CommandEmpty>
                {groups.map(([heading, people]) =>
                  people.length === 0 ? null : (
                    <CommandGroup key={heading ?? 'all'} heading={heading ?? undefined}>
                      {people.map((c) => (
                        <CommandItem
                          key={c.id}
                          value={c.id}
                          onSelect={() => {
                            setOpen(false);
                            setQuery('');
                            onSelect(c);
                          }}
                          className="flex items-center gap-2 text-[13px]"
                        >
                          {selectedId !== undefined && (
                            <Check aria-hidden="true" className={cn('size-3.5', selectedId !== c.id && 'opacity-0')} />
                          )}
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">
                              {c.name}
                              {selectedId === c.id && <span className="sr-only"> (chosen)</span>}
                            </span>
                            {c.detail && <span className="truncate text-[11px] text-muted-foreground">{c.detail}</span>}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ),
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
