import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { Eye, Download, Pencil, FolderInput, ArrowRightLeft, Trash2, Users } from 'lucide-react';
import type { ActiveSection } from './useExplorerState';

interface ExplorerContextMenuProps {
  children: React.ReactNode;
  itemType: 'file' | 'folder';
  section: ActiveSection;
  onPreview?: () => void;
  onDownload?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onMoveToShared?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
}

export default function ExplorerContextMenu({
  children,
  itemType,
  section,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onMoveToShared,
  onShare,
  onDelete,
}: ExplorerContextMenuProps) {
  const isShared = section === 'owner';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {itemType === 'file' && onPreview && (
          <ContextMenuItem onClick={onPreview} className="gap-2">
            <Eye className="w-3.5 h-3.5" /> View
          </ContextMenuItem>
        )}
        {itemType === 'file' && onDownload && (
          <ContextMenuItem onClick={onDownload} className="gap-2">
            <Download className="w-3.5 h-3.5" /> Download
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem onClick={onRename} className="gap-2">
            <Pencil className="w-3.5 h-3.5" /> Rename
          </ContextMenuItem>
        )}
        {onShare && (
          <ContextMenuItem onClick={onShare} className="gap-2">
            <Users className="w-3.5 h-3.5" /> Share…
          </ContextMenuItem>
        )}
        {isShared && onMove && (
          <ContextMenuItem onClick={onMove} className="gap-2">
            <FolderInput className="w-3.5 h-3.5" /> Move
          </ContextMenuItem>
        )}
        {!isShared && itemType === 'file' && onMoveToShared && (
          <ContextMenuItem onClick={onMoveToShared} className="gap-2">
            <ArrowRightLeft className="w-3.5 h-3.5" /> Move to shared
          </ContextMenuItem>
        )}
        {onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem onClick={onDelete} className="gap-2 text-destructive focus:text-destructive">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
