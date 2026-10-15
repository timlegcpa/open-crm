import { memo, useEffect, useRef } from 'react';
import { Folder, FileText, Download, Trash2, Check, Users } from 'lucide-react';
import { formatFileSize, formatDate, formatDateShort, splitFilename, NO_VALUE_TEXT } from '@/lib/format';
import { renderContains } from '../lib/documentNames';
import { SHARED_WITH_UNKNOWN } from './sharedWith';
import ExplorerContextMenu from './ExplorerContextMenu';
import type { ActiveSection, DialogTarget } from './useExplorerState';
import type { ClientDocument, ClientFolder } from './types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TableCell, TableRow } from '@/components/ui/table';
import { ToneBadge } from '@/components/ui/tone-badge';
import { ClickRegion } from '@/components/ui/click-region';
import { cn } from '@/lib/utils';

/**
 * Cell padding + row height for every row the explorer draws: column header,
 * group header, the ".." row, folders and files, at the client root and inside
 * a folder alike.
 *
 * The height is stated on the ROW rather than left to whatever the cells
 * happen to contain. The tallest thing in a row is a hover-action button and
 * not every row has one, so without it the rows of one list would differ in
 * height and the list would jump the moment a folder opened.
 *
 * 34px data rows under a 30px column header, 12.5px text.
 */
export const FILE_ROW = 'h-[34px]';
export const FILE_HEAD = 'h-[30px]';
export const FILE_CELL = 'px-3 py-0 align-middle text-[12.5px]';

interface FileListRowProps {
  item: ClientDocument | ClientFolder;
  itemType: 'file' | 'folder';
  section: ActiveSection;
  contactId: string;
  childCounts?: { folders: number; files: number; lastModified: string | null };
  onOpen?: (folderName: string) => void;
  onPreview?: (file: ClientDocument) => void;
  /** Owner only: double-click / Enter opens the full-screen workstation. */
  onOpenFullScreen?: (file: ClientDocument) => void;
  onDownload?: (file: ClientDocument) => void;
  onRequestRename?: (target: DialogTarget) => void;
  onRequestMove?: (target: DialogTarget) => void;
  onRequestMoveToShared?: (target: DialogTarget) => void;
  onRequestDelete?: (target: DialogTarget) => void;
  /** Files only: open the per-document share picker. */
  onRequestShare?: (file: ClientDocument) => void;
  /** Resolved name of the contact this file is currently shared with, or null.
   *  Resolved by the parent from the relationship rows it already holds so the
   *  row doesn't need a second embed on every document. */
  sharedWithName?: string | null;
  // Review props
  isUnreviewed?: boolean;
  /** Folder rows only: count of unreviewed descendants (subfolders + docs).
   * Lets the row signal "this folder is itself reviewed but contains items
   * that still need attention", the most common state once cascading
   * review is in use. Ignored on file rows. */
  unreviewedDescendantCount?: number;
  onToggleReview?: (itemId: string, currentlyReviewed: boolean, itemType: 'file' | 'folder') => void;
  // Selection props
  isSelected?: boolean;
  /** `range` is true on a shift-click: select from the last clicked row to this one. */
  onToggleSelect?: (id: string, range: boolean) => void;
  // Drag-and-drop props, source: one pair for both file + folder rows.
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, id: string, itemType: 'file' | 'folder') => void;
  onDragEnd?: (itemType: 'file' | 'folder') => void;
  // Drag-and-drop props, drop target (folders only).
  isDropTarget?: boolean;
  onFolderDragOver?: (e: React.DragEvent, folderId: string) => void;
  onFolderDragEnter?: (e: React.DragEvent, folderId: string) => void;
  onFolderDragLeave?: (e: React.DragEvent) => void;
  onFolderDrop?: (e: React.DragEvent, folderId: string, folderName: string) => void;
}

/**
 * The Review column: a coloured dot and plain words, no capsule. Amber "Needs
 * review"; muted "Reviewed Sep 29" with the full date on hover; for a folder, "N to review" when
 * something inside still waits. With `onToggle` the words are the toggle.
 */
function ReviewStatus({
  isFolder,
  isUnreviewed,
  unreviewedDescendantCount,
  reviewedAt,
  onToggle,
}: {
  isFolder: boolean;
  isUnreviewed: boolean;
  unreviewedDescendantCount: number;
  reviewedAt: string | null;
  onToggle?: () => void;
}) {
  const pending = isFolder && unreviewedDescendantCount > 0;
  const needsReview = isUnreviewed || pending;
  const label = pending
    ? `${unreviewedDescendantCount} to review`
    : isUnreviewed
      ? 'Needs review'
      : reviewedAt ? `Reviewed ${formatDateShort(reviewedAt)}` : 'Reviewed';
  const status = reviewedAt && !needsReview ? `Reviewed ${formatDate(reviewedAt)}` : label;
  const content = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]',
        needsReview ? 'font-medium text-warning-dark' : 'text-muted-foreground',
      )}
    >
      <span
        className={cn('h-[7px] w-[7px] shrink-0 rounded-full', needsReview ? 'bg-warning' : 'bg-success')}
        aria-hidden
      />
      {/* Phones get the dot alone; the words stay for screen readers and in the title. */}
      <span className="sr-only md:not-sr-only">{label}</span>
    </span>
  );
  if (!onToggle) return <span title={status}>{content}</span>;
  return (
    <ClickRegion
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      // The row opens the document on Enter and preventDefaults it, which would
      // cancel this button's own activation.
      onKeyDown={(e) => e.stopPropagation()}
      title={`${status}. Click to mark ${isUnreviewed ? 'reviewed' : 'unreviewed'}.`}
      aria-label={`${label}. Mark ${isUnreviewed ? 'reviewed' : 'unreviewed'}`}
      className="rounded-sm hover:underline"
    >
      {content}
    </ClickRegion>
  );
}

function FileListRow({
  item,
  itemType,
  section,
  contactId,
  childCounts,
  onOpen,
  onPreview,
  onOpenFullScreen,
  onDownload,
  onRequestRename,
  onRequestMove,
  onRequestMoveToShared,
  onRequestDelete,
  onRequestShare,
  sharedWithName,
  isUnreviewed,
  unreviewedDescendantCount = 0,
  onToggleReview,
  isSelected,
  onToggleSelect,
  draggable,
  onDragStart,
  onDragEnd,
  isDropTarget,
  onFolderDragOver,
  onFolderDragEnter,
  onFolderDragLeave,
  onFolderDrop,
}: FileListRowProps) {
  const inSharedSection = section === 'owner';
  const isFolder = itemType === 'folder';
  const folderName = isFolder ? (item as ClientFolder).name : undefined;
  const fileDoc = isFolder ? undefined : (item as ClientDocument);
  const displayName = isFolder ? folderName! : splitFilename(fileDoc!.original_filename).name;

  const requestRename = onRequestRename
    ? () => onRequestRename(
        isFolder
          ? { id: item.id, name: folderName!, type: 'folder', contactId }
          : { id: item.id, name: fileDoc!.original_filename, type: 'file', contactId }
      )
    : undefined;

  const requestDelete = onRequestDelete
    ? () => onRequestDelete(
        isFolder
          ? { id: item.id, name: folderName!, type: 'folder', contactId }
          : { id: item.id, name: fileDoc!.original_filename, type: 'file', contactId }
      )
    : undefined;

  const requestMove = onRequestMove
    ? () => onRequestMove(
        isFolder
          ? { id: item.id, name: folderName!, type: 'folder', contactId, heldBy: section || undefined }
          : { id: item.id, name: fileDoc!.original_filename, type: 'file', contactId, heldBy: section || undefined }
      )
    : undefined;

  const requestMoveToShared = onRequestMoveToShared && !isFolder
    ? () => onRequestMoveToShared({ id: item.id, name: fileDoc!.original_filename, type: 'file', contactId })
    : undefined;

  const handleOpen = isFolder && onOpen ? () => onOpen(folderName!) : undefined;
  const handlePreview = !isFolder && onPreview ? () => onPreview(fileDoc!) : undefined;
  const handleOpenFullScreen =
    !isFolder && onOpenFullScreen ? () => onOpenFullScreen(fileDoc!) : undefined;
  // Enter needs a focusable row, so the row takes tabIndex. Space is left alone:
  // it scrolls the list.
  // Defer the single-click preview so a double-click can cancel it. Otherwise
  // opening the workstation also decrypts the same document in the inline pane
  // (one double-click produced three failed-preview toasts).
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );
  const handleRowClick = (e: React.MouseEvent) => {
    // Shift- or Ctrl/Cmd-click on a row selects instead of opening, as in any
    // file list: shift takes the range, Ctrl/Cmd adds or removes the one row.
    if (handleToggleSelect && (e.shiftKey || e.ctrlKey || e.metaKey)) return handleToggleSelect(e);
    if (isFolder) return handleOpen?.();
    if (!handleOpenFullScreen) return handlePreview?.();
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      handlePreview?.();
    }, 200);
  };
  const handleRowDoubleClick = (e: React.MouseEvent) => {
    // A modified double-click is two selection clicks, never an open.
    if (handleToggleSelect && (e.shiftKey || e.ctrlKey || e.metaKey)) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    handleOpenFullScreen?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (isFolder) handleOpen?.();
    else (handleOpenFullScreen ?? handlePreview)?.();
  };
  // Folders have no share column: sharing is per document, so a folder-level
  // control would have to fan out to its contents, which is exactly the
  // implicit-sharing behaviour the schema refuses to have.
  const requestShare = !isFolder && onRequestShare ? () => onRequestShare(fileDoc!) : undefined;
  const isShared = !isFolder && !!fileDoc!.shared_with_contact_id;
  const shareTitle = isShared
    ? `Shared with ${sharedWithName ?? SHARED_WITH_UNKNOWN} (read-only)`
    : 'Not shared';
  const handleDownload = !isFolder && onDownload ? () => onDownload(fileDoc!) : undefined;
  const handleToggleSelect = onToggleSelect
    ? (e: React.MouseEvent | React.KeyboardEvent) => onToggleSelect(item.id, e.shiftKey)
    : undefined;
  const handleToggleReview = onToggleReview
    ? () => onToggleReview(item.id, !!(item as { reviewed_at?: string | null }).reviewed_at, itemType)
    : undefined;

  // Only the buttons that still render on the row; the rest live in the
  // context menu, and and counting them here would reserve a column for nothing.
  const hasActions = !!(handleDownload || requestDelete || handleToggleReview);

  const handleDragStart = onDragStart ? (e: React.DragEvent) => onDragStart(e, item.id, itemType) : undefined;
  const handleDragEnd = onDragEnd ? () => onDragEnd(itemType) : undefined;
  const handleDragOver = isFolder && onFolderDragOver ? (e: React.DragEvent) => onFolderDragOver(e, item.id) : undefined;
  const handleDragEnter = isFolder && onFolderDragEnter ? (e: React.DragEvent) => onFolderDragEnter(e, item.id) : undefined;
  const handleDrop = isFolder && onFolderDrop ? (e: React.DragEvent) => onFolderDrop(e, item.id, folderName!) : undefined;

  return (
    <ExplorerContextMenu
      itemType={itemType}
      section={section}
      onPreview={handlePreview}
      onDownload={handleDownload}
      onRename={requestRename}
      onMove={requestMove}
      onMoveToShared={requestMoveToShared}
      onShare={requestShare}
      onDelete={requestDelete}
    >
      <TableRow
        onClick={handleRowClick}
        onDoubleClick={isFolder ? undefined : handleRowDoubleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        data-state={isSelected ? 'selected' : undefined}
        draggable={draggable}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={isFolder ? onFolderDragLeave : undefined}
        onDrop={handleDrop}
        className={cn(
          'group select-none cursor-pointer',
          FILE_ROW,
          isDropTarget && 'bg-accent ring-1 ring-inset ring-ring',
          draggable && 'cursor-grab active:cursor-grabbing',
        )}
      >
        {/* Col 1: Checkbox. The column only exists when selection does. */}
        {handleToggleSelect && (
          <TableCell className={FILE_CELL}>
            <Checkbox
              checked={isSelected || false}
              aria-label={`Select ${displayName}`}
              // The click carries the shift key; preventDefault stops the
              // checkbox toggling itself, since `checked` is driven from state.
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleToggleSelect(e);
              }}
            />
          </TableCell>
        )}

        {/* Col 2: Icon + Name */}
        <TableCell className={cn(FILE_CELL, 'max-w-0')}>
          <div className="flex items-center gap-2 min-w-0">
          {/* Both icons are neutral: the palette keeps green, amber and red
              for STATUS, and which half of the tree a folder sits
              in is not a status. The section is named by the breadcrumb. */}
          {isFolder ? (
            <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          ) : (
            <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          )}
          <span
            className={cn(
              'truncate min-w-0 text-foreground',
              isFolder ? 'font-medium' : 'font-normal',
            )}
            title={displayName}
          >
            {displayName}
          </span>
          {/* Share state is stated on the row, not just in a hover title: a
              document that a second person can read must never look identical
              to one only this contact can see. */}
          {isShared && (
            <ToneBadge variant="info" className="shrink-0 gap-1" title={shareTitle}>
              <Users className="w-2.5 h-2.5" aria-hidden="true" />
              Shared
            </ToneBadge>
          )}
          </div>
        </TableCell>

        {/* Col 3: Contents / Size */}
        <TableCell className={cn(FILE_CELL, 'hidden md:table-cell', 'text-muted-foreground tabular-nums truncate')}>
          {isFolder
            ? renderContains(childCounts)
            : 'file_size' in item && item.file_size ? formatFileSize(item.file_size) : NO_VALUE_TEXT
          }
        </TableCell>

        {/* Col 4: Modified */}
        <TableCell className={cn(FILE_CELL, 'hidden md:table-cell', 'text-muted-foreground tabular-nums whitespace-nowrap')}>
          {isFolder
            ? (childCounts?.lastModified
                ? formatDate(childCounts.lastModified)
                : item.created_at ? formatDate(item.created_at) : NO_VALUE_TEXT)
            : (item.created_at ? formatDate(item.created_at) : NO_VALUE_TEXT)
          }
        </TableCell>

        {/* Col 5: Review status. Its own column so the state lines up down the
            list. Client items only; shared rows keep an empty cell so the
            columns still align. A file's status IS the toggle; a folder's
            only reports, because "3 to review" is about its contents and a
            click there would flip the folder's own flag instead. */}
        <TableCell className={FILE_CELL}>
          {section === 'client' && <ReviewStatus
            isFolder={isFolder}
            isUnreviewed={!!isUnreviewed}
            unreviewedDescendantCount={unreviewedDescendantCount}
            reviewedAt={item.reviewed_at}
            onToggle={isFolder ? undefined : handleToggleReview}
          />}
        </TableCell>

        {/* Col 6: Actions. Revealed on hover at desktop widths: six always-on
            grey icons per row was most of what made this list read as busy.
            `focus-within` keeps them reachable by keyboard, and below `lg`
            (where there is no hover) they stay visible. */}
        {hasActions && (
        <TableCell className={FILE_CELL} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
          {/* Shared files: Download + Delete */}
          {inSharedSection && !isFolder && handleDownload && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground [&_svg]:size-3.5" onClick={handleDownload} title="Download" aria-label={`Download ${displayName}`}>
              <Download className="w-3.5 h-3.5" />
            </Button>
          )}
          {requestDelete && (
            <Button variant="ghost" size="icon-sm" className="hover:bg-destructive-light text-muted-foreground hover:text-destructive [&_svg]:size-3.5" onClick={requestDelete} title="Delete" aria-label={`Delete ${displayName}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}

          {/* Client items: Review toggle + Download */}
          {!inSharedSection && handleToggleReview && (
            <Button variant="ghost" size="icon-sm"
              onClick={handleToggleReview}
              className={cn(
                '[&_svg]:size-3.5',
                isUnreviewed ? 'text-muted-foreground hover:text-foreground' : 'text-success hover:text-success-dark',
              )}
              title={isUnreviewed ? 'Mark as reviewed' : 'Mark as unreviewed'}
              aria-label={isUnreviewed ? `Mark ${displayName} reviewed` : `Mark ${displayName} unreviewed`}
            >
              <Check className="w-3.5 h-3.5" />
            </Button>
          )}
          {!inSharedSection && !isFolder && handleDownload && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground [&_svg]:size-3.5" onClick={handleDownload} title="Download" aria-label={`Download ${displayName}`}>
              <Download className="w-3.5 h-3.5" />
            </Button>
          )}
          </div>
        </TableCell>
        )}
      </TableRow>
    </ExplorerContextMenu>
  );
}

export default memo(FileListRow);
