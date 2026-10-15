import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, FolderInput } from 'lucide-react';
import { folderKeys, listAllFolders } from '../api';
import type { Section } from '../types';
import FolderDestinationSelect from './FolderDestinationSelect';

interface BulkMoveDialogProps {
  open: boolean;
  fileIds: string[];
  folderIds: string[];
  contactId: string;
  heldBy: Section;
  onClose: () => void;
  onMoveFile: (docId: string, newPath: string, contactId: string) => Promise<void>;
  onMoveFolder: (folderId: string, newParentPath: string, contactId: string) => Promise<void>;
}

export default function BulkMoveDialog({
  open,
  fileIds,
  folderIds,
  contactId,
  heldBy,
  onClose,
  onMoveFile,
  onMoveFolder,
}: BulkMoveDialogProps) {
  const [folderPath, setFolderPath] = useState('/');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: allFolders = [] } = useQuery({
    queryKey: folderKeys.listAll(contactId, heldBy),
    queryFn: () => listAllFolders(contactId, heldBy),
    enabled: !!contactId && open,
    staleTime: 2 * 60 * 1000,
  });

  const total = fileIds.length + folderIds.length;
  const close = () => { setFolderPath('/'); onClose(); };

  const handleSubmit = async () => {
    if (total === 0) return;
    setIsSubmitting(true);
    try {
      // Each move toasts its own failure and never throws, so one bad item does not
      // stop the rest; the dialog closes on the partial result either way.
      for (const id of folderIds) await onMoveFolder(id, folderPath, contactId);
      for (const id of fileIds) await onMoveFile(id, folderPath, contactId);
    } finally {
      setIsSubmitting(false);
      close();
    }
  };

  const titleParts: string[] = [];
  if (folderIds.length) titleParts.push(`${folderIds.length} folder${folderIds.length !== 1 ? 's' : ''}`);
  if (fileIds.length) titleParts.push(`${fileIds.length} file${fileIds.length !== 1 ? 's' : ''}`);
  const title = `Move ${titleParts.join(' and ') || 'items'}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-4">
          <FolderDestinationSelect folders={allFolders} value={folderPath} onChange={setFolderPath} excludedIds={folderIds} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
            <Button size="sm" disabled={isSubmitting || total === 0} onClick={() => void handleSubmit()}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <FolderInput className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              Move
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
