import { useState } from 'react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-react';
import type { DialogTarget } from './useExplorerState';

interface DeleteConfirmDialogProps {
  target: DialogTarget | null;
  onClose: () => void;
  onDeleteFile: (id: string, contactId: string) => Promise<void>;
  onDeleteFolder: (id: string, name: string, contactId: string) => Promise<void>;
}

export default function DeleteConfirmDialog({ target, onClose, onDeleteFile, onDeleteFolder }: DeleteConfirmDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!target) return;
    setIsDeleting(true);
    try {
      if (target.type === 'file') {
        await onDeleteFile(target.id, target.contactId || '');
      } else {
        await onDeleteFolder(target.id, target.name, target.contactId || '');
      }
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {target?.type === 'folder' ? 'folder' : 'file'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.type === 'folder'
              ? `Delete the folder "${target.name}" and every folder inside it? The documents in them are not deleted: they move to the top level of this section.`
              : `Delete "${target?.name ?? ''}"? This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:ring-destructive"
          >
            {isDeleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
