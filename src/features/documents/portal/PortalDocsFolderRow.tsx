import { memo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { ClickRegion } from '@/components/ui/click-region';
import { Folder, Pencil, Trash2 } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { renderContains } from '../lib/documentNames';
import type { ClientFolder, Section } from '../types';
import IconAction from './IconAction';

interface PortalDocsFolderRowProps {
  folder: ClientFolder;
  childCounts: { folders: number; files: number } | undefined;
  section: Section;
  onOpen: (folderName: string) => void;
  selected?: boolean;
  isDrop?: boolean;
  onToggleSelect?: (id: string) => void;
  onRename?: (folder: ClientFolder) => void;
  onDelete?: (folder: ClientFolder) => void;
  onFolderDragOver?: (e: React.DragEvent, folderName: string) => void;
  onFolderDragLeave?: (e: React.DragEvent) => void;
  onFolderDrop?: (e: React.DragEvent, folderName: string) => void;
}

/** A folder in the list. Only the client's own section ('client') can be selected, renamed, deleted or dropped onto. */
function PortalDocsFolderRow({
  folder,
  childCounts,
  section,
  onOpen,
  selected = false,
  isDrop = false,
  onToggleSelect,
  onRename,
  onDelete,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
}: PortalDocsFolderRowProps) {
  const editable = section === 'client';
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-2 border-b border-border px-3.5 py-1.5',
        isDrop && 'bg-muted outline-dashed outline-2 -outline-offset-2 outline-ring',
        selected && !isDrop && 'bg-muted/60',
      )}
      onDragOver={onFolderDragOver ? (e) => onFolderDragOver(e, folder.name) : undefined}
      onDragLeave={onFolderDragLeave}
      onDrop={onFolderDrop ? (e) => onFolderDrop(e, folder.name) : undefined}
    >
      {editable && onToggleSelect && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(folder.id)}
          aria-label={`Select folder ${folder.name}`}
        />
      )}
      <ClickRegion
        onClick={() => onOpen(folder.name)}
        aria-label={`Open folder ${folder.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1"
      >
        <Folder size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-semibold text-foreground">{folder.name}</span>
      </ClickRegion>
      <span className="hidden w-28 shrink-0 text-[13px] text-muted-foreground sm:block">{renderContains(childCounts)}</span>
      <span className="hidden w-24 shrink-0 text-right text-[13px] text-muted-foreground md:block">{formatDate(folder.created_at)}</span>
      <div className="flex shrink-0 items-center justify-end gap-0.5 sm:w-28">
        {editable && onRename && (
          <IconAction label={`Rename folder ${folder.name}`} onClick={() => onRename(folder)}>
            <Pencil size={14} aria-hidden="true" />
          </IconAction>
        )}
        {editable && onDelete && (
          <IconAction label={`Delete folder ${folder.name}`} onClick={() => onDelete(folder)} destructive>
            <Trash2 size={14} aria-hidden="true" />
          </IconAction>
        )}
      </div>
    </li>
  );
}

export default memo(PortalDocsFolderRow);
