import { useState, useCallback, type ReactNode } from 'react';
import { CornerLeftUp } from 'lucide-react';
import FileListRow, { FILE_CELL, FILE_HEAD, FILE_ROW } from './FileListRow';
import type { ActiveSection, DialogTarget } from './useExplorerState';
import type { ClientDocument, ClientFolder } from './types';
import { childPath, parentOf } from '../lib/folderPath';
import { Checkbox } from '@/components/ui/checkbox';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TABLE_TH } from '@/components/layout/page';
import { cn } from '@/lib/utils';

/**
 * The per-row verbs, defined once.
 *
 * `FileGrid` (inside a section) and `ClientOverviewPane` (the client root)
 * both spread the same object into `FileGridRows`, so a row carries the same
 * controls wherever it is drawn. None of these needs an active section: every
 * dialog target is built from the row's own `section` and `contactId`, and
 * every mutation is keyed by id. The overview used to omit all of them on the
 * belief that they resolved against the active section, which was true of
 * nothing but New folder and Upload.
 */
export interface RowActions {
  onDownload?: (file: ClientDocument) => void;
  onPreview?: (file: ClientDocument) => void;
  onOpenFullScreen?: (file: ClientDocument) => void;
  onSetRenameTarget?: (target: DialogTarget | null) => void;
  onSetMoveTarget?: (target: DialogTarget | null) => void;
  onSetMoveToSharedTarget?: (target: DialogTarget | null) => void;
  onSetDeleteTarget?: (target: DialogTarget | null) => void;
  /** Files only: open the per-document share picker. */
  onRequestShare?: (file: ClientDocument) => void;
  /** documentId -> resolved recipient name, for rows that are shared. Resolved
   *  by the explorer from the relationship rows it already holds. */
  sharedWithNames?: Record<string, string>;
  onMoveFile?: (docId: string, newPath: string, contactId: string) => void;
  onMoveFolder?: (folderId: string, newParentPath: string, contactId: string) => void;
  // Review props
  onToggleReview?: (itemId: string, currentlyReviewed: boolean, itemType?: 'file' | 'folder') => void;
  // Selection props
  selectedItems?: Set<string>;
  onToggleSelectItem?: (id: string, order?: readonly string[]) => void;
}

type FolderChildCounts = Record<string, { folders: number; files: number; lastModified: string | null }>;

interface FileGridProps extends RowActions {
  folders: ClientFolder[];
  files: ClientDocument[];
  activeSection: ActiveSection;
  currentPath: string;
  selectedClientId: string;
  folderChildCounts?: FolderChildCounts;
  /** Map of folder.id → count of unreviewed descendants (docs + subfolders).
   * Only populated when activeSection === 'client'. Drives the folder rows'
   * "N to review" so the owner can see where to drill in. */
  unreviewedDescendantCounts?: Record<string, number>;
  onNavigateUp: () => void;
  onNavigateToFolder: (folderName: string) => void;
  onSelectAll?: (ids: string[]) => void;
  onClearSelection?: () => void;
}

/**
 * The explorer's column widths.
 *
 * A `<colgroup>` on a `table-fixed` table, not a grid template string. The
 * select column only EXISTS when selection does: carrying an empty 36px column
 * at the client root is what indented every folder and file 36px past its own
 * section heading.
 */
export function FileGridColumns({ hasSelection }: { hasSelection?: boolean }) {
  return (
    <colgroup>
      {hasSelection && <col style={{ width: 36 }} />}
      <col />
      {/* Their cells are `hidden` below md; the cols follow so `table-fixed`
          does not keep reserving the width of a column that isn't drawn. */}
      <col className="hidden md:table-column" style={{ width: 110 }} />
      <col className="hidden md:table-column" style={{ width: 130 }} />
      {/* Review status: "Needs review" / "Reviewed Sep 29" / "3 to review".
          Below md only the dot shows, so the column narrows with it. */}
      <col className="w-8 md:w-32" />
      {/* three 28px buttons, their gaps, and the cell's own padding */}
      <col style={{ width: 116 }} />
    </colgroup>
  );
}

/**
 * The explorer's table. A bare `<table>`, not the shared `Table`: that one wraps itself
 * in an `overflow-auto` box, which would become the sticky header's scroll container and
 * pin it to a box that never scrolls. The pane's ScrollArea is the scroll container here.
 */
export function ExplorerTable({ className, children }: { className?: string; children: ReactNode }) {
  return <table className={cn('w-full caption-bottom table-fixed text-sm', className)}>{children}</table>;
}

/** How many columns a full-width row spans: everything after the select column. */
export const FULL_ROW_SPAN = 5;

/**
 * The explorer's column header.
 *
 * `sticky` sits on the `<th>` cells, not on `<thead>`: Tailwind's preflight
 * sets `border-collapse: collapse`, under which Chrome ignores a sticky
 * section element but honours a sticky cell. The bottom rule therefore has to
 * live on the cells too.
 */
export function FileGridHeader({
  hasSelection,
  allSelected,
  someSelected,
  onToggleAll,
}: {
  hasSelection?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onToggleAll?: () => void;
}) {
  const th = cn(TABLE_TH, FILE_HEAD, 'sticky top-0 z-20 bg-muted border-b border-border');
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        {hasSelection && (
          <TableHead className={th}>
            {/* Radix carries the tri-state on `checked`; the old `ref` mutation
                of the DOM `indeterminate` property has no equivalent. */}
            <Checkbox
              aria-label="Select all"
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={onToggleAll}
            />
          </TableHead>
        )}
        <TableHead className={th}>Name</TableHead>
        <TableHead className={cn(th, 'hidden md:table-cell')}>Contents</TableHead>
        <TableHead className={cn(th, 'hidden md:table-cell')}>Modified</TableHead>
        <TableHead className={th}>Review</TableHead>
        <TableHead className={th}><span className="sr-only">Actions</span></TableHead>
      </TableRow>
    </TableHeader>
  );
}

/**
 * A full-width section heading INSIDE the table: the contact root's "Shared
 * documents" / "Uploaded documents". It starts in the Name column, so its label lines up
 * with the filenames beneath it instead of sitting 36px to their left.
 */
export function FileGroupRow({
  hasSelection,
  icon: Icon,
  iconClass,
  label,
  onClick,
  actions,
}: {
  hasSelection?: boolean;
  icon: typeof CornerLeftUp;
  iconClass: string;
  label: string;
  onClick: () => void;
  /** Buttons on the right of the heading (New folder, Upload). Their clicks
   *  stay theirs: the row itself opens the section. */
  actions?: ReactNode;
}) {
  return (
    <TableRow className={cn(FILE_ROW, 'cursor-pointer bg-muted/50')} onClick={onClick}>
      {hasSelection && <TableCell className={FILE_CELL} />}
      <TableCell colSpan={FULL_ROW_SPAN} className={FILE_CELL}>
        <div className="flex items-center gap-2">
          <Icon className={cn('w-4 h-4 flex-shrink-0', iconClass)} aria-hidden="true" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="rounded-sm text-[11px] font-semibold uppercase tracking-wider text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {label}
          </button>
          {actions && (
            <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              {actions}
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export interface ExplorerDrag {
  dropTargetId: string | null;
  handleDragStart: (e: React.DragEvent, id: string, itemType: 'file' | 'folder') => void;
  handleDragEnd: (itemType: 'file' | 'folder') => void;
  handleFolderDragOver: (e: React.DragEvent, folderId: string) => void;
  handleFolderDragEnter: (e: React.DragEvent, folderId: string) => void;
  handleFolderDragLeave: (e: React.DragEvent) => void;
  handleFolderDrop: (e: React.DragEvent, targetFolderId: string, folderName: string) => void;
  handleParentDrop: (e: React.DragEvent) => void;
}

const dragHasKnownType = (e: React.DragEvent) =>
  e.dataTransfer.types.includes('application/x-explorer-file') ||
  e.dataTransfer.types.includes('application/x-explorer-folder');

/**
 * Drag-and-drop for one listing: rows as sources, folders (and the ".." row)
 * as targets. Only folder drags need tracking, for the drop-on-self block.
 * A drop resolves its destination from `currentPath` and the target folder's
 * name, so the client root passes `/` and gets a move into a root folder.
 */
export function useExplorerDrag({
  currentPath,
  contactId,
  onMoveFile,
  onMoveFolder,
}: {
  currentPath: string;
  contactId: string;
  onMoveFile?: RowActions['onMoveFile'];
  onMoveFolder?: RowActions['onMoveFolder'];
}): ExplorerDrag {
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Unified drag source handlers (file + folder rows).
  const handleDragStart = useCallback((e: React.DragEvent, id: string, itemType: 'file' | 'folder') => {
    const mime = itemType === 'folder' ? 'application/x-explorer-folder' : 'application/x-explorer-file';
    e.dataTransfer.setData(mime, id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    if (itemType === 'folder') setDraggedFolderId(id);
  }, []);

  const handleDragEnd = useCallback((itemType: 'file' | 'folder') => {
    if (itemType === 'folder') setDraggedFolderId(null);
    setDropTargetId(null);
  }, []);

  // Folder drop handlers (files + folders)
  const handleFolderDragOver = useCallback((e: React.DragEvent, folderId: string) => {
    if (!dragHasKnownType(e)) return;
    // A folder cannot be dropped onto itself; do not mark this row as a valid target.
    if (draggedFolderId && draggedFolderId === folderId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [draggedFolderId]);

  const handleFolderDragEnter = useCallback((e: React.DragEvent, folderId: string) => {
    if (!dragHasKnownType(e)) return;
    if (draggedFolderId && draggedFolderId === folderId) return;
    e.preventDefault();
    setDropTargetId(folderId);
  }, [draggedFolderId]);

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTargetId(null);
    }
  }, []);

  const handleFolderDrop = useCallback((e: React.DragEvent, targetFolderId: string, folderName: string) => {
    e.preventDefault();
    const draggedFileId = e.dataTransfer.getData('application/x-explorer-file');
    const draggedFolder = e.dataTransfer.getData('application/x-explorer-folder');
    const targetPath = childPath(currentPath, folderName);
    if (draggedFileId && onMoveFile) {
      onMoveFile(draggedFileId, targetPath, contactId);
    } else if (draggedFolder && draggedFolder !== targetFolderId && onMoveFolder) {
      onMoveFolder(draggedFolder, targetPath, contactId);
    }
    setDraggedFolderId(null);
    setDropTargetId(null);
  }, [currentPath, contactId, onMoveFile, onMoveFolder]);

  // ".." row drop handler (move to parent)
  const handleParentDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const fileId = e.dataTransfer.getData('application/x-explorer-file');
    const folderId = e.dataTransfer.getData('application/x-explorer-folder');
    const parentPath = parentOf(currentPath);
    if (fileId && onMoveFile) {
      onMoveFile(fileId, parentPath, contactId);
    } else if (folderId && onMoveFolder) {
      onMoveFolder(folderId, parentPath, contactId);
    }
    setDraggedFolderId(null);
    setDropTargetId(null);
  }, [currentPath, contactId, onMoveFile, onMoveFolder]);

  return {
    dropTargetId,
    handleDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleFolderDragEnter,
    handleFolderDragLeave,
    handleFolderDrop,
    handleParentDrop,
  };
}

/**
 * The folder and file rows of one listing: the ONE place a `ClientDocument`
 * or `ClientFolder` becomes a `FileListRow` with its verbs attached. Returns
 * rows, not a table, so the client root can stack two sections in one
 * `<TableBody>`. Drag-and-drop and the review toggle are gated on the
 * section here, exactly as they were, so a caller may hand the same `drag`
 * and `onToggleReview` to both halves.
 */
export function FileGridRows({
  folders,
  files,
  section,
  contactId,
  currentPath,
  folderChildCounts,
  unreviewedDescendantCounts,
  onNavigateToFolder,
  drag,
  onDownload,
  onPreview,
  onOpenFullScreen,
  onSetRenameTarget,
  onSetMoveTarget,
  onSetMoveToSharedTarget,
  onSetDeleteTarget,
  onRequestShare,
  sharedWithNames,
  onToggleReview,
  selectedItems,
  onToggleSelectItem,
}: RowActions & {
  folders: ClientFolder[];
  files: ClientDocument[];
  section: ActiveSection;
  contactId: string;
  currentPath: string;
  folderChildCounts?: FolderChildCounts;
  unreviewedDescendantCounts?: Record<string, number>;
  onNavigateToFolder: (folderName: string) => void;
  drag?: ExplorerDrag;
}) {
  const isShared = section === 'owner';
  const isClient = section === 'client';
  // Rows drag in the shared section only: a client's uploads stay where the client put them.
  const dnd = isShared ? drag : undefined;
  const hasSelection = !!selectedItems && !!onToggleSelectItem;
  // A shift-click hands over the rows as drawn here, folders then files.
  const onToggleSelect = onToggleSelectItem
    ? (id: string, range: boolean) =>
        range
          ? onToggleSelectItem(id, [...folders.map((f) => f.id), ...files.map((f) => f.id)])
          : onToggleSelectItem(id)
    : undefined;

  return (
    <>
      {folders.map((folder: ClientFolder) => {
        const folderPath = childPath(currentPath, folder.name);
        const counts = folderChildCounts?.[folderPath];
        const unreviewedCount = unreviewedDescendantCounts?.[folder.id] ?? 0;
        return (
          <FileListRow
            key={folder.id}
            item={folder}
            itemType="folder"
            section={section}
            contactId={contactId}
            childCounts={counts}
            onOpen={onNavigateToFolder}
            onRequestRename={onSetRenameTarget}
            onRequestMove={onSetMoveTarget}
            onRequestDelete={onSetDeleteTarget}
            isUnreviewed={isClient && !folder.reviewed_at}
            unreviewedDescendantCount={isClient ? unreviewedCount : 0}
            onToggleReview={isClient ? onToggleReview : undefined}
            isSelected={hasSelection ? selectedItems!.has(folder.id) : undefined}
            onToggleSelect={onToggleSelect}
            isDropTarget={dnd?.dropTargetId === folder.id}
            draggable={!!dnd}
            onDragStart={dnd?.handleDragStart}
            onDragEnd={dnd?.handleDragEnd}
            onFolderDragOver={dnd?.handleFolderDragOver}
            onFolderDragEnter={dnd?.handleFolderDragEnter}
            onFolderDragLeave={dnd?.handleFolderDragLeave}
            onFolderDrop={dnd?.handleFolderDrop}
          />
        );
      })}
      {files.map((file: ClientDocument) => (
        <FileListRow
          key={file.id}
          item={file}
          itemType="file"
          section={section}
          contactId={contactId}
          isUnreviewed={isClient && !file.reviewed_at}
          onToggleReview={isClient ? onToggleReview : undefined}
          onPreview={onPreview}
          onOpenFullScreen={onOpenFullScreen}
          onDownload={onDownload}
          onRequestRename={onSetRenameTarget}
          onRequestMove={onSetMoveTarget}
          onRequestMoveToShared={onSetMoveToSharedTarget}
          onRequestDelete={onSetDeleteTarget}
          onRequestShare={onRequestShare}
          sharedWithName={
            file.shared_with_contact_id ? sharedWithNames?.[file.id] ?? null : null
          }
          isSelected={hasSelection ? selectedItems!.has(file.id) : undefined}
          onToggleSelect={onToggleSelect}
          draggable={!!dnd}
          onDragStart={dnd?.handleDragStart}
          onDragEnd={dnd?.handleDragEnd}
        />
      ))}
    </>
  );
}

export default function FileGrid({
  folders,
  files,
  activeSection,
  currentPath,
  selectedClientId,
  folderChildCounts,
  unreviewedDescendantCounts,
  onNavigateUp,
  onNavigateToFolder,
  onSelectAll,
  onClearSelection,
  ...rowActions
}: FileGridProps) {
  const showGoUp = activeSection !== null && currentPath !== '/';
  const isEmpty = folders.length === 0 && files.length === 0 && !showGoUp;
  const isShared = activeSection === 'owner';
  const { selectedItems, onToggleSelectItem, onMoveFile, onMoveFolder } = rowActions;
  const hasSelection = !!selectedItems && !!onToggleSelectItem;

  // Select all logic
  const allIds = hasSelection ? [...folders.map((f: ClientFolder) => f.id), ...files.map((f: ClientDocument) => f.id)] : [];
  const allSelected = hasSelection && allIds.length > 0 && allIds.every(id => selectedItems!.has(id));
  const someSelected = hasSelection && allIds.some(id => selectedItems!.has(id)) && !allSelected;

  const drag = useExplorerDrag({ currentPath, contactId: selectedClientId, onMoveFile, onMoveFolder });

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted-foreground font-medium">This folder is empty</p>
        <p className="text-xs text-muted-foreground mt-1">
          {activeSection === 'owner'
            ? 'Upload files or create folders to get started.'
            : 'No files have been uploaded here yet.'}
        </p>
      </div>
    );
  }

  return (
    <ExplorerTable className="border-t border-border">
      <FileGridColumns hasSelection={hasSelection} />
      <FileGridHeader
        hasSelection={hasSelection}
        allSelected={allSelected}
        someSelected={someSelected}
        onToggleAll={() => (allSelected ? onClearSelection?.() : onSelectAll?.(allIds))}
      />
      <TableBody>
      {showGoUp && (
        <TableRow
          onClick={onNavigateUp}
          onDragOver={isShared ? (e: React.DragEvent) => drag.handleFolderDragOver(e, 'parent') : undefined}
          onDragEnter={isShared ? (e: React.DragEvent) => drag.handleFolderDragEnter(e, 'parent') : undefined}
          onDragLeave={isShared ? drag.handleFolderDragLeave : undefined}
          onDrop={isShared ? drag.handleParentDrop : undefined}
          className={cn(
            FILE_ROW,
            'cursor-pointer',
            drag.dropTargetId === 'parent' && 'bg-accent ring-1 ring-inset ring-ring',
          )}
        >
          {hasSelection && <TableCell className={FILE_CELL} />}
          <TableCell colSpan={FULL_ROW_SPAN} className={FILE_CELL}>
            <div className="flex items-center gap-2">
              <CornerLeftUp className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
              <button type="button" onClick={(e) => { e.stopPropagation(); onNavigateUp(); }} className="rounded-sm text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Up one folder">..</button>
            </div>
          </TableCell>
        </TableRow>
      )}
      <FileGridRows
        {...rowActions}
        folders={folders}
        files={files}
        section={activeSection}
        contactId={selectedClientId}
        currentPath={currentPath}
        folderChildCounts={folderChildCounts}
        unreviewedDescendantCounts={unreviewedDescendantCounts}
        onNavigateToFolder={onNavigateToFolder}
        drag={drag}
      />
      </TableBody>
    </ExplorerTable>
  );
}
