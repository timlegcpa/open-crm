import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchiveRestore } from 'lucide-react';
import { contactDisplayName, type Contact } from '@/api/contacts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { links } from '@/features/links';
import { matchesCrmSearch, type BoardOrganization } from '../lib/board';

/**
 * Everyone archived, searchable, A to Z, each with Restore. Restore clears the archive and
 * nothing else, so the person comes back at the stage they left, which the row names.
 */
export function ArchivedPeopleDialog({
  open,
  onOpenChange,
  contacts,
  organizationsOf,
  statusLabel,
  onRestore,
  restoringIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The archived contacts only. */
  contacts: readonly Contact[];
  organizationsOf: (contactId: string) => readonly BoardOrganization[];
  statusLabel: (status: string) => string;
  onRestore: (contact: Contact) => void;
  restoringIds: ReadonlySet<string>;
}) {
  const [search, setSearch] = useState('');
  const rows = useMemo(
    () =>
      contacts
        .filter((c) => matchesCrmSearch(c, organizationsOf(c.id), search))
        .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b)) || a.id.localeCompare(b.id)),
    [contacts, organizationsOf, search],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setSearch('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Archived people</DialogTitle>
          <DialogDescription>Their records and history are kept. Restore someone to bring them back at the stage they left.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Search archived people" placeholder="Search archived people" value={search} onChange={(e) => setSearch(e.target.value)} />
        <ScrollArea className="max-h-[55vh]" fitWidth>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              {contacts.length === 0 ? 'No archived people.' : 'No archived people match your search.'}
            </p>
          ) : (
            <ul aria-label="Archived people" className="divide-y divide-border">
              {rows.map((c) => {
                const name = contactDisplayName(c);
                const restoring = restoringIds.has(c.id);
                return (
                  <li key={c.id} className="flex min-w-0 items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link
                        to={links.contact(c.id)}
                        onClick={() => onOpenChange(false)}
                        className="block truncate text-[13px] font-medium underline-offset-2 hover:underline"
                      >
                        {name}
                      </Link>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {c.full_name && c.business_name ? `${c.business_name} · ` : ''}Restores to {statusLabel(c.status)}
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" aria-label={`Restore ${name}`} disabled={restoring} onClick={() => onRestore(c)}>
                      <ArchiveRestore aria-hidden="true" />
                      {restoring ? 'Restoring...' : 'Restore'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
