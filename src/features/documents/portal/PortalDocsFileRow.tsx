import { memo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { ClickRegion } from '@/components/ui/click-region';
import { Download, FolderInput, Pencil, Trash2 } from 'lucide-react';
import { formatDate, formatFileSize, splitFilename } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ClientDocument } from '../types';
import FileTypeIcon from './FileTypeIcon';
import IconAction from './IconAction';

interface PortalDocsFileRowProps {
  file: ClientDocument;
  /** The client's own uploads: selectable, renamable, movable, deletable and draggable onto a folder. */
  editable: boolean;
  selected?: boolean;
  isDragged?: boolean;
  onToggleSelect?: (id: string) => void;
  onPreview: (file: ClientDocument) => void;
  onDownload: (file: ClientDocument) => void;
  onRename?: (file: ClientDocument) => void;
  onMove?: (file: ClientDocument) => void;
  onDelete?: (file: ClientDocument) => void;
  onDragStart?: (e: React.DragEvent<HTMLLIElement>, id: string) => void;
  onDragEnd?: () => void;
}

function PortalDocsFileRow({
  file,
  editable,
  selected = false,
  isDragged = false,
  onToggleSelect,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
}: PortalDocsFileRowProps) {
  const filename = file.original_filename;
  const { name: baseName } = splitFilename(filename);

  return (
    <li
      draggable={editable && onDragStart ? true : undefined}
      onDragStart={editable && onDragStart ? (e) => onDragStart(e, file.id) : undefined}
      onDragEnd={editable ? onDragEnd : undefined}
      className={cn(
        'flex min-w-0 items-center gap-2 border-b border-border px-3.5 py-1.5',
        isDragged && 'opacity-40',
        selected && 'bg-muted/60',
      )}
    >
      {editable && onToggleSelect && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(file.id)}
          aria-label={`Select ${filename}`}
        />
      )}
      <ClickRegion
        onClick={() => onPreview(file)}
        aria-label={`Preview ${filename}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1"
      >
        <FileTypeIcon filename={filename} />
        <span className="truncate text-sm font-medium text-foreground">{baseName}</span>
      </ClickRegion>
      <span className="hidden w-28 shrink-0 text-[13px] text-muted-foreground sm:block">{formatFileSize(file.file_size)}</span>
      <span className="hidden w-24 shrink-0 text-right text-[13px] text-muted-foreground md:block">{formatDate(file.created_at)}</span>
      <div className="flex shrink-0 items-center justify-end gap-0.5 sm:w-28">
        <IconAction label={`Download ${filename}`} onClick={() => onDownload(file)}>
          <Download size={14} aria-hidden="true" />
        </IconAction>
        {editable && onRename && (
          <IconAction label={`Rename ${filename}`} onClick={() => onRename(file)}>
            <Pencil size={14} aria-hidden="true" />
          </IconAction>
        )}
        {editable && onMove && (
          <IconAction label={`Move ${filename}`} onClick={() => onMove(file)}>
            <FolderInput size={14} aria-hidden="true" />
          </IconAction>
        )}
        {editable && onDelete && (
          <IconAction label={`Delete ${filename}`} onClick={() => onDelete(file)} destructive>
            <Trash2 size={14} aria-hidden="true" />
          </IconAction>
        )}
      </div>
    </li>
  );
}

export default memo(PortalDocsFileRow);
