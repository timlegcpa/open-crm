import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactDisplayName, listContacts } from '@/api/contacts';
import {
  addRelationship,
  listHousehold,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  removeRelationship,
  type RelationshipKind,
} from '@/api/contactRelationships';
import { queryKeys } from '@/api/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getErrorMessage } from '@/lib/errors';

const MAX_RESULTS = 20;

/** Links to other contacts, in both directions, and a picker to add one. */
export function HouseholdPanel({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: queryKeys.contactRelationships.forContact(contactId),
    queryFn: () => listHousehold(contactId),
  });
  const [open, setOpen] = useState(false);

  // A link shows on both contacts' records, so every household is stale, not just this one.
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.contactRelationships.all });

  const unlink = useMutation({ mutationFn: removeRelationship, onSettled: refresh });

  return (
    <section aria-labelledby="household-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="household-heading" className="text-base font-semibold">Household</h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Link contact</Button>
      </div>
      {links.isPending && <p className="text-sm text-muted-foreground">Loading household...</p>}
      {links.isError && <p role="alert" className="text-sm text-destructive">Could not load household: {getErrorMessage(links.error)}</p>}
      {unlink.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(unlink.error, 'The link was not removed.')}</p>}
      {links.data?.length === 0 && <p className="text-sm text-muted-foreground">No linked contacts.</p>}
      <ul className="flex flex-col gap-2">
        {links.data?.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{RELATIONSHIP_LABELS[l.relationship] ?? l.relationship}:</span>
            <Link to={`/contacts/${l.otherId}`} className="underline">{l.otherName}</Link>
            {l.direction === 'incoming' && <span className="text-muted-foreground">(linked from their record)</span>}
            <Button size="xs" variant="ghost" disabled={unlink.isPending} onClick={() => unlink.mutate(l.id)}>
              Unlink {l.otherName}
            </Button>
          </li>
        ))}
      </ul>
      {open && <LinkDialog contactId={contactId} onClose={() => setOpen(false)} onLinked={refresh} />}
    </section>
  );
}

function LinkDialog({ contactId, onClose, onLinked }: { contactId: string; onClose: () => void; onLinked: () => void }) {
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts });
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<RelationshipKind>('spouse');

  const results = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (contacts.data ?? [])
      .filter((c) => c.id !== contactId)
      .filter((c) => needle === '' || [c.full_name, c.business_name, c.email].filter(Boolean).join(' ').toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);
  }, [contacts.data, search, contactId]);

  const link = useMutation({
    mutationFn: () => addRelationship({ contactId, relatedContactId: picked!, relationship }),
    onSuccess: () => {
      onLinked();
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link a contact</DialogTitle>
          <DialogDescription>Find the other contact and choose how they are related.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Find a contact" placeholder="Search by name, business or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        {contacts.isPending && <p className="text-sm text-muted-foreground">Loading contacts...</p>}
        {contacts.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(contacts.error)}</p>}
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto" aria-label="Matching contacts">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={picked === c.id}
                onClick={() => setPicked(c.id)}
                className={`w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent ${picked === c.id ? 'bg-accent font-medium' : ''}`}
              >
                {contactDisplayName(c)}
                {c.email && <span className="ml-2 text-muted-foreground">{c.email}</span>}
              </button>
            </li>
          ))}
          {contacts.data && results.length === 0 && <li className="text-sm text-muted-foreground">No matching contacts.</li>}
        </ul>
        <Select value={relationship} onValueChange={(v) => setRelationship(v as RelationshipKind)}>
          <SelectTrigger aria-label="Relationship"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RELATIONSHIP_KINDS.map((k) => <SelectItem key={k} value={k}>{RELATIONSHIP_LABELS[k]}</SelectItem>)}
          </SelectContent>
        </Select>
        {link.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(link.error, 'The link was not saved.')}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!picked || link.isPending} onClick={() => link.mutate()}>Link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
