import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, FolderInput } from 'lucide-react';
import { folderKeys, listAllFolders } from '../api';
import { isSection } from '../types';
import type { DialogTarget } from './useExplorerState';
import FolderDestinationSelect from './FolderDestinationSelect';

interface MoveDialogProps {
  target: DialogTarget | null;
  onClose: () => void;
  onMoveFile: (docId: string, newPath: string, contactId: string) => Promise<void>;
  onMoveFolder: (folderId: string, newParentPath: string, contactId: string) => Promise<void>;
}

export default function MoveDialog({ target, onClose, onMoveFile, onMoveFolder }: MoveDialogProps) {
  const [folderPath, setFolderPath] = useState('/');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const contactId = target?.contactId || '';
  const heldBy = isSection(target?.heldBy) ? target.heldBy : 'owner';
  const isFolder = target?.type === 'folder';

  const { data: allFolders = [] } = useQuery({
    queryKey: folderKeys.listAll(contactId, heldBy),
    queryFn: () => listAllFolders(contactId, heldBy),
    enabled: !!contactId && !!target,
  });

  const close = () => { setFolderPath('/'); onClose(); };

  const handleSubmit = async () => {
    if (!target) return;
    setIsSubmitting(true);
    try {
      if (isFolder) await onMoveFolder(target.id, folderPath, contactId);
      else await onMoveFile(target.id, folderPath, contactId);
      close();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isFolder ? 'Move folder' : 'Move file'}</DialogTitle>
          <DialogDescription>Move "{target?.name}" to a different folder.</DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-4">
          <FolderDestinationSelect
            folders={allFolders}
            value={folderPath}
            onChange={setFolderPath}
            excludedIds={isFolder && target ? [target.id] : []}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
            <Button size="sm" disabled={isSubmitting} onClick={() => void handleSubmit()}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <FolderInput className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              Move
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
