import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowRightLeft, Copy } from 'lucide-react';
import { folderKeys, listAllFolders } from '../api';
import type { DialogTarget } from './useExplorerState';
import FolderDestinationSelect from './FolderDestinationSelect';

interface MoveToSharedDialogProps {
  target: DialogTarget | null;
  onClose: () => void;
  onMoveToShared: (docId: string, folderPath: string, contactId: string) => Promise<void>;
  onCopyToShared: (docId: string, folderPath: string, contactId: string) => Promise<void>;
}

/** Move or copy one of the contact's uploads into the shared section. */
export default function MoveToSharedDialog({ target, onClose, onMoveToShared, onCopyToShared }: MoveToSharedDialogProps) {
  const [folderPath, setFolderPath] = useState('/');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const contactId = target?.contactId || '';

  const { data: folders = [] } = useQuery({
    queryKey: folderKeys.listAll(contactId, 'owner'),
    queryFn: () => listAllFolders(contactId, 'owner'),
    enabled: !!contactId && !!target,
  });

  const close = () => { setFolderPath('/'); onClose(); };

  const handleSubmit = async (mode: 'move' | 'copy') => {
    if (!target) return;
    setIsSubmitting(true);
    try {
      if (mode === 'copy') await onCopyToShared(target.id, folderPath, contactId);
      else await onMoveToShared(target.id, folderPath, contactId);
      close();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move or copy to shared documents</DialogTitle>
          <DialogDescription>Put "{target?.name}" in the shared section.</DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-4">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Move</span> takes it out of the contact's uploads.{' '}
            <span className="font-medium text-foreground">Copy</span> keeps the upload where it is.
          </p>
          <FolderDestinationSelect folders={folders} value={folderPath} onChange={setFolderPath} label="Destination folder" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
            <Button variant="outline" size="sm" disabled={isSubmitting} onClick={() => void handleSubmit('copy')}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Copy className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              Copy
            </Button>
            <Button size="sm" disabled={isSubmitting} onClick={() => void handleSubmit('move')}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRightLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              Move
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
