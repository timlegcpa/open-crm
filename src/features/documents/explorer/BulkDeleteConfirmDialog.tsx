import { useState } from 'react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-react';

interface BulkDeleteConfirmDialogProps {
  open: boolean;
  fileCount: number;
  folderCount: number;
  /**
   * How many of the selected files are in the shared section. Named separately because at
   * the contact's root one Select-all spans both sections, so a count alone would let a
   * shared document be deleted by someone who believed they were clearing an upload.
   */
  sharedFileCount?: number;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export default function BulkDeleteConfirmDialog({ open, fileCount, folderCount, sharedFileCount = 0, onConfirm, onClose }: BulkDeleteConfirmDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };

  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
  if (folderCount > 0) parts.push(`${folderCount} folder${folderCount !== 1 ? 's' : ''}`);
  const itemDesc = parts.join(' and ');

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete selected items</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {itemDesc}?
            {sharedFileCount > 0 && ` ${sharedFileCount} of the files ${sharedFileCount === 1 ? 'is' : 'are'} in shared documents, not the contact's own uploads.`}
            {folderCount > 0 && ' Documents inside the folders move to the top level of their section.'}
            {' '}This cannot be undone.
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
