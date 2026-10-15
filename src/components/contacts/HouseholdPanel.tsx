import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, UserPlus, X } from 'lucide-react';
import {
  addRelationship,
  listHousehold,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  removeRelationship,
  type RelationshipKind,
} from '@/api/contactRelationships';
import { queryKeys } from '@/api/queryKeys';
import { ContactPicker } from '@/components/contacts/ContactPicker';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ContactCandidate } from '@/hooks/useContactCandidates';
import { getErrorMessage } from '@/lib/errors';

/**
 * People linked to this contact, in both directions, and a picker to link one.
 *
 * A link is an identity record and nothing more: it grants no access to anything. The card
 * says so in visible copy, because the obvious reading of "link these two" is that their
 * records are now shared, which is the opposite of what the schema does. Sharing is a
 * separate, deliberate act wherever it exists. Never derive access from a row here.
 */
export function HouseholdPanel({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const household = useQuery({
    queryKey: queryKeys.contactRelationships.forContact(contactId),
    queryFn: () => listHousehold(contactId),
  });
  const [open, setOpen] = useState(false);

  // A link shows on both contacts' records, so every household is stale, not just this one.
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.contactRelationships.all });

  const unlink = useMutation({
    mutationFn: removeRelationship,
    onError: (err) => toast.error(getErrorMessage(err, 'The link was not removed.')),
    onSettled: refresh,
  });

  return (
    <Panel
      title="Household"
      action={
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
          <UserPlus aria-hidden="true" />
          Link a person
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-3.5 py-3 text-[13px]">
        {household.isPending && <p className="text-muted-foreground">Loading household...</p>}
        {household.isError && (
          <p role="alert" className="text-destructive">Could not load household: {getErrorMessage(household.error)}</p>
        )}
        {household.data?.length === 0 && <p className="text-muted-foreground">No linked people.</p>}
        {household.data && household.data.length > 0 && (
          <ul className="flex flex-col gap-1">
            {household.data.map((l) => (
              <li key={l.id} className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 text-[12px] text-muted-foreground">{RELATIONSHIP_LABELS[l.relationship] ?? l.relationship}</span>
                <Link to={`/contacts/${l.otherId}`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
                  {l.otherName}
                </Link>
                {l.direction === 'incoming' && <span className="shrink-0 text-[11px] text-muted-foreground">from their record</span>}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Unlink ${l.otherName}`}
                  disabled={unlink.isPending}
                  onClick={() => void unlink.mutateAsync(l.id).catch(() => undefined)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">A link records who someone is. It grants no access to anything.</p>
      </div>
      {open && <LinkDialog contactId={contactId} onClose={() => setOpen(false)} onLinked={refresh} />}
    </Panel>
  );
}

function LinkDialog({ contactId, onClose, onLinked }: { contactId: string; onClose: () => void; onLinked: () => void }) {
  const [picked, setPicked] = useState<ContactCandidate | null>(null);
  const [relationship, setRelationship] = useState<RelationshipKind>('spouse');
  const [error, setError] = useState<string | null>(null);

  const link = useMutation({
    mutationFn: (other: string) => addRelationship({ contactId, relatedContactId: other, relationship }),
  });

  const submit = async () => {
    if (!picked) return;
    setError(null);
    try {
      await link.mutateAsync(picked.id);
      onLinked();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'The link was not saved.'));
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link a person</DialogTitle>
          <DialogDescription>
            This records who someone is on this record. It grants them no access to anything.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label id="link-person-label">Person</Label>
            <ContactPicker onSelect={(c) => setPicked(c.id === contactId ? null : c)} selectedId={picked?.id ?? null}>
              <Button type="button" variant="outline" aria-labelledby="link-person-label" className="w-full justify-between font-normal">
                <span className="truncate">{picked ? picked.name : 'Choose a contact'}</span>
                <ChevronsUpDown aria-hidden="true" className="opacity-60" />
              </Button>
            </ContactPicker>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-relationship">Relationship</Label>
            <Select value={relationship} onValueChange={(v) => setRelationship(v as RelationshipKind)}>
              <SelectTrigger id="link-relationship"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RELATIONSHIP_KINDS.map((k) => <SelectItem key={k} value={k}>{RELATIONSHIP_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!picked || link.isPending} onClick={() => void submit()}>Link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
