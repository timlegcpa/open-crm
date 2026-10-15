import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { queryKeys } from '@/api/queryKeys';
import { listHousehold, RELATIONSHIP_LABELS } from '@/api/contactRelationships';
import { getErrorMessage } from '@/lib/errors';
import { documentKeys, setShare } from '../api';

// Radix Select forbids an empty value, so "nobody" needs a sentinel.
const NOT_SHARED = '__not_shared__';

export interface ShareTarget {
  id: string;
  name: string;
  /** The document's own contact: the source of the linked-people list. */
  contactId: string;
  sharedWithContactId: string | null;
}

/**
 * Sets or clears `client_documents.shared_with_contact_id` for one document.
 *
 * The candidate list is exactly this contact's linked people (contact relationships),
 * because a free contact search here would make a mis-click a disclosure. **The link is
 * only the candidate list: it grants nothing on its own.** This dialog is what grants
 * access, one document at a time.
 *
 * The recipient's access is READ-ONLY (the UPDATE and DELETE policies do not match a
 * shared row), and the copy says so because "shared" otherwise reads as "can change it".
 */
export default function ShareDocumentDialog({
  target,
  onClose,
}: {
  target: ShareTarget | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>(NOT_SHARED);

  useEffect(() => {
    setSelected(target?.sharedWithContactId ?? NOT_SHARED);
  }, [target]);

  const contactId = target?.contactId ?? '';
  const { data: links = [], isPending: linksPending } = useQuery({
    queryKey: queryKeys.contactRelationships.forContact(contactId),
    queryFn: () => listHousehold(contactId),
    enabled: !!contactId,
  });

  // The share must always resolve to a CURRENTLY linked person or to nobody.
  // `selected` is seeded from the row, so a document shared with someone who was
  // since unlinked would keep their id here while the Select that could change it
  // is never rendered, and Save would write the same id back: the share could never
  // be revoked. Collapsing an unlinked selection to null keeps "remove the link,
  // then turn sharing off" reachable.
  const effectiveShare = selected !== NOT_SHARED && links.some((l) => l.otherId === selected) ? selected : null;
  const orphanedShare = !linksPending && !!target?.sharedWithContactId && effectiveShare === null;
  const selectedName = links.find((l) => l.otherId === selected)?.otherName ?? 'this person';

  const saveMutation = useMutation({
    mutationFn: () => setShare(target!.id, effectiveShare),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
      toast.success(effectiveShare === null ? 'Sharing turned off.' : 'Document shared.');
      onClose();
    },
  });

  const save = async () => {
    try {
      await saveMutation.mutateAsync();
    } catch (err: unknown) {
      toast.error('Sharing was not changed', { description: getErrorMessage(err) });
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share document</DialogTitle>
          <DialogDescription>
            Choose one person who can also see <span className="font-medium">{target?.name}</span> in their portal.
            They get read-only access: they can view and download it, but cannot rename, move or delete it.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {links.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {orphanedShare
                ? 'This document is still shared with someone who is no longer linked to this contact. Saving turns sharing off and removes it from their portal.'
                : 'Nobody is linked to this contact yet. Link a person on the contact record first, then come back to share this document with them.'}
            </p>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="share-with">Shared with</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id="share-with">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_SHARED}>Not shared</SelectItem>
                  {links.map((link) => (
                    <SelectItem key={link.id} value={link.otherId}>
                      {link.otherName} ({RELATIONSHIP_LABELS[link.relationship].toLowerCase()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Names the consequence in full: the trigger shows only a name, and a
                  name alone does not say what that person can do with the file. */}
              <p className="text-[12px] text-muted-foreground">
                {selected === NOT_SHARED
                  ? 'Only this contact can see this document.'
                  : `Shared with ${selectedName} (read-only). It appears in their portal; they cannot rename, move or delete it.`}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            // NOT gated on links.length: a document shared with someone later unlinked
            // still has a live share, and gating Save would leave no way to revoke it.
            // It IS gated on the links settling: `links` is [] while loading, which would
            // otherwise collapse a valid share to null on a fast Save.
            disabled={saveMutation.isPending || linksPending}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
