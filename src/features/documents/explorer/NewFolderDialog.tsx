import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { validateName } from '../lib/documentNames';
import type { Section } from '../types';

interface NewFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateFolder: (contactId: string, name: string, parentPath: string, heldBy: Section) => Promise<void>;
  contactId: string;
  currentPath: string;
  heldBy: Section;
}

export default function NewFolderDialog({ open, onClose, onCreateFolder, contactId, currentPath, heldBy }: NewFolderDialogProps) {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // The database refuses `/` and `\` too (they would read as path separators);
  // this says why, rather than only blocking the button.
  const nameError = name.trim() ? validateName(name.trim(), 100) : null;

  const handleSubmit = async () => {
    if (!name.trim() || nameError || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onCreateFolder(contactId, name.trim(), currentPath, heldBy);
      setName('');
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) { setName(''); onClose(); }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription className="sr-only">Name the new folder</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
            placeholder="For example: Contracts"
            aria-label="Folder name"
            maxLength={100}
            autoFocus
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>Cancel</Button>
            <Button size="sm" disabled={!name.trim() || !!nameError || isSubmitting} onClick={() => void handleSubmit()}>
              {isSubmitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
