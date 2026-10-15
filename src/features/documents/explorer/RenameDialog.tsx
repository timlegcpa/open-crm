import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { splitFilename } from '@/lib/format';
import type { DialogTarget } from './useExplorerState';
import { Input } from '@/components/ui/input';
import { validateName } from '../lib/documentNames';

interface RenameDialogProps {
  target: DialogTarget | null;
  onClose: () => void;
  onRenameFile: (id: string, newName: string, contactId: string) => Promise<void>;
  onRenameFolder: (id: string, newName: string, contactId: string) => Promise<void>;
}

export default function RenameDialog({ target, onClose, onRenameFile, onRenameFolder }: RenameDialogProps) {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isFile = target?.type === 'file';
  const ext = isFile && target ? splitFilename(target.name).ext : '';
  const originalName = isFile && target ? splitFilename(target.name).name : (target?.name || '');

  useEffect(() => {
    if (target) setValue(isFile ? splitFilename(target.name).name : target.name);
  }, [target, isFile]);

  // The database refuses `/`, `\` and control characters in both names (a folder's
  // would read as path separators); this says why, rather than only blocking the
  // button. A folder name is bounded at 100, a file name (with its extension) at 255.
  const nameError = value.trim() ? validateName(isFile ? value.trim() + ext : value.trim(), isFile ? 255 : 100) : null;

  const handleSubmit = async () => {
    if (!target || !value.trim() || value.trim() === originalName || nameError || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (isFile) {
        await onRenameFile(target.id, value.trim() + ext, target.contactId || '');
      } else {
        await onRenameFolder(target.id, value.trim(), target.contactId || '');
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename {target?.type === 'folder' ? 'folder' : 'file'}</DialogTitle>
          <DialogDescription className="sr-only">Enter a new name</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <Input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={isFile ? "File name" : "Folder name"}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
            autoFocus
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!value.trim() || value.trim() === originalName || !!nameError || isSubmitting} onClick={() => void handleSubmit()}>
              {isSubmitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
              Rename
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
