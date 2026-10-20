import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown } from 'lucide-react';
import { ContactPicker } from '@/components/contacts/ContactPicker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { links } from '@/features/links';

export interface PickedContact {
  id: string;
  name: string;
}

/**
 * The one way to start a request: choose who it is for, then Next opens the builder for
 * them. The Requests page, the new request page and a contact's requests on Documents open
 * this; `defaultContact` fills the contact in where it is already known (a contact's own
 * Requests tab skips it and opens the builder directly).
 */
export function NewRequestDialog({
  open,
  onOpenChange,
  defaultContact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultContact?: PickedContact;
}) {
  const navigate = useNavigate();
  const [contact, setContact] = useState<PickedContact | null>(null);
  const defaultId = defaultContact?.id;
  const defaultName = defaultContact?.name;

  // Each opening starts from the known contact, or from none.
  useEffect(() => {
    if (open) setContact(defaultId ? { id: defaultId, name: defaultName ?? '' } : null);
  }, [open, defaultId, defaultName]);

  const next = () => {
    if (!contact) return;
    onOpenChange(false);
    navigate(links.newRequest(contact.id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>Choose who it is for, then build what to ask them.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label id="new-request-contact-label">Contact</Label>
          <ContactPicker grouped selectedId={contact?.id ?? null} onSelect={(c) => setContact({ id: c.id, name: c.name })}>
            <Button variant="outline" className="w-full justify-between font-normal" aria-labelledby="new-request-contact-label new-request-contact-value">
              <span id="new-request-contact-value" className={contact ? 'truncate' : 'truncate text-muted-foreground'}>
                {contact?.name || 'Choose a contact'}
              </span>
              <ChevronsUpDown className="opacity-50" aria-hidden />
            </Button>
          </ContactPicker>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!contact} onClick={next}>
            Next
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
