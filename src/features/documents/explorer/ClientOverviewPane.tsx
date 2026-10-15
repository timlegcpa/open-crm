// The two-section overview shown when a contact is selected in the index but no
// section is active yet. It renders the root contents of both sections stacked,
// so the owner sees what is where without drilling into one first.
//
// It is the SAME table as the folder view (same `<colgroup>`, same
// `FileGridHeader`, same `FileGridRows`), so entering a folder changes the
// breadcrumb and adds a ".." row, and nothing else moves.
//
// The rows carry the same verbs as the folder view: hover actions, the
// right-click menu, checkboxes and drag-and-drop, through the one `RowActions`
// bundle the explorer also hands `FileGrid`. Each row builds its own targets
// from its `section` and `contactId`; only New folder and Upload need a section
// chosen, and each section's heading carries its own pair.
//
// The data comes in as props. The explorer runs `useSectionRoot` for both
// halves itself, so the bulk bar and the Shared badges read the same rows this
// pane draws.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { documentKeys, folderKeys, listDocumentsAtPath, listFoldersAtPath } from '../api';
import type { ClientDocument, ClientFolder } from './types';
import { SECTION_ICON, SECTION_LABEL, type Section } from './useExplorerState';
import { CreateButtons } from './ExplorerToolbar';
import {
  ExplorerTable,
  FileGridColumns,
  FileGridHeader,
  FileGridRows,
  FileGroupRow,
  FULL_ROW_SPAN,
  useExplorerDrag,
  type ExplorerDrag,
  type RowActions,
} from './FileGrid';
import { FILE_CELL, FILE_ROW } from './FileListRow';
import { cn } from '@/lib/utils';

export interface SectionRoot {
  folders: ClientFolder[];
  files: ClientDocument[];
  isLoading: boolean;
}

// Stable empties. A `= []` default hands back a NEW array every render while its query is
// disabled, so every memo keyed on it recomputes forever. Exported because the explorer's own
// root-level queries are disabled in exactly the same way and had the same `= []` defaults.
export const NO_FOLDERS: ClientFolder[] = [];
export const NO_FILES: ClientDocument[] = [];

/** The root listing of one section: the rows the overview draws for it. */
export function useSectionRoot(
  clientId: string | null,
  section: Section,
  enabled: boolean,
): SectionRoot {
  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: folderKeys.atPath(clientId ?? '', '/', section),
    queryFn: () => listFoldersAtPath(clientId!, '/', section),
    enabled: enabled && !!clientId,
  });

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: documentKeys.atPath(clientId ?? '', '/', section),
    queryFn: () => listDocumentsAtPath(clientId!, '/', section),
    enabled: enabled && !!clientId,
  });

  return useMemo(
    () => ({
      folders: folders ?? NO_FOLDERS,
      files: files ?? NO_FILES,
      isLoading: foldersLoading || filesLoading,
    }),
    [folders, files, foldersLoading, filesLoading],
  );
}

/** What reaches the rows: the bundle minus the two open verbs, rebound per section below. */
type OverviewRowActions = Omit<RowActions, 'onPreview' | 'onOpenFullScreen'>;

interface ClientOverviewPaneProps extends RowActions {
  clientId: string;
  shared: SectionRoot;
  client: SectionRoot;
  onEnterSection: (section: Section, path?: string) => void;
  /**
   * Opening a file from the root means entering its section first, so the
   * workstation's rail lands on the right half. Click, double-click and Enter
   * all go this way: the folder view's `onPreview` and `onOpenFullScreen` are
   * taken off the bundle here, and the full-screen verb is offered only where
   * the explorer offers it (a desk, not a phone).
   */
  onPreviewFile: (section: Section, file: ClientDocument) => void;
  onSelectAll?: (ids: string[]) => void;
  onClearSelection?: () => void;
  /** New folder / Upload into one half, from that half's heading. */
  onNewFolder?: (section: Section) => void;
  onUploadClick?: (section: Section) => void;
}

export default function ClientOverviewPane({
  clientId,
  shared,
  client,
  onEnterSection,
  onPreviewFile,
  onNewFolder,
  onUploadClick,
  onSelectAll,
  onClearSelection,
  onPreview: _folderViewPreview,
  onOpenFullScreen,
  ...rowActions
}: ClientOverviewPaneProps) {
  const { selectedItems, onToggleSelectItem, onMoveFile, onMoveFolder } = rowActions;
  const hasSelection = !!selectedItems && !!onToggleSelectItem;

  // Select-all spans both halves: the header checkbox is one control over one
  // list, and the bulk bar already works out which half each item belongs to.
  const allIds = hasSelection
    ? [shared, client].flatMap((root) => [...root.folders.map((f) => f.id), ...root.files.map((f) => f.id)])
    : [];
  const allSelected = hasSelection && allIds.length > 0 && allIds.every((id) => selectedItems!.has(id));
  // A shift-click range runs across both halves, in the order they are drawn,
  // not just the half the click landed in.
  const sectionRowActions = onToggleSelectItem
    ? {
        ...rowActions,
        onToggleSelectItem: (id: string, order?: readonly string[]) =>
          order ? onToggleSelectItem(id, allIds) : onToggleSelectItem(id),
      }
    : rowActions;
  const someSelected = hasSelection && allIds.some((id) => selectedItems!.has(id)) && !allSelected;

  // One drag context for the whole table. `FileGridRows` wires it onto shared
  // rows only, the same gate the folder view applies, so an upload can never
  // be dropped into a shared folder from here either.
  const drag = useExplorerDrag({ currentPath: '/', contactId: clientId, onMoveFile, onMoveFolder });

  return (
    <ScrollArea className="h-full">
      {/* The ScrollArea owns the scrolling (see ExplorerTable). */}
      <ExplorerTable className="border-t border-border">
        <FileGridColumns hasSelection={hasSelection} />
        <FileGridHeader
          hasSelection={hasSelection}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleAll={() => (allSelected ? onClearSelection?.() : onSelectAll?.(allIds))}
        />
        <TableBody>
          <SectionRows
            section="owner"
            root={shared}
            clientId={clientId}
            hasSelection={hasSelection}
            drag={drag}
            rowActions={sectionRowActions}
            onEnterSection={onEnterSection}
            onPreviewFile={onPreviewFile}
            canOpenFullScreen={!!onOpenFullScreen}
            onNewFolder={onNewFolder}
            onUploadClick={onUploadClick}
          />
          <SectionRows
            section="client"
            root={client}
            clientId={clientId}
            hasSelection={hasSelection}
            drag={drag}
            rowActions={sectionRowActions}
            onEnterSection={onEnterSection}
            onPreviewFile={onPreviewFile}
            canOpenFullScreen={!!onOpenFullScreen}
            onNewFolder={onNewFolder}
            onUploadClick={onUploadClick}
          />
        </TableBody>
      </ExplorerTable>
    </ScrollArea>
  );
}

/** Returns rows, not a wrapper: both sections share one `<TableBody>` so the
 *  column widths are resolved once for the whole list. */
function SectionRows({
  section,
  root,
  clientId,
  hasSelection,
  drag,
  rowActions,
  onEnterSection,
  onPreviewFile,
  canOpenFullScreen,
  onNewFolder,
  onUploadClick,
}: {
  section: Section;
  root: SectionRoot;
  clientId: string;
  hasSelection: boolean;
  drag: ExplorerDrag;
  rowActions: OverviewRowActions;
  onEnterSection: (section: Section, path?: string) => void;
  onPreviewFile: (section: Section, file: ClientDocument) => void;
  canOpenFullScreen: boolean;
  onNewFolder?: (section: Section) => void;
  onUploadClick?: (section: Section) => void;
}) {
  const isEmpty = root.folders.length === 0 && root.files.length === 0;
  const openFile = (file: ClientDocument) => onPreviewFile(section, file);

  return (
    <>
      <FileGroupRow
        hasSelection={hasSelection}
        icon={SECTION_ICON[section]}
        iconClass="text-muted-foreground"
        label={SECTION_LABEL[section]}
        onClick={() => onEnterSection(section)}
        actions={
          onNewFolder && onUploadClick ? (
            <CreateButtons section={section} onNewFolder={onNewFolder} onUploadClick={onUploadClick} size="xs" />
          ) : undefined
        }
      />

      {root.isLoading || isEmpty ? (
        <TableRow className={cn(FILE_ROW, 'hover:bg-transparent')}>
          {hasSelection && <TableCell className={FILE_CELL} />}
          <TableCell colSpan={FULL_ROW_SPAN} className={FILE_CELL}>
            {root.isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-label="Loading" />
            ) : (
              <span className="text-[13px] text-muted-foreground">No documents yet.</span>
            )}
          </TableCell>
        </TableRow>
      ) : (
        <FileGridRows
          {...rowActions}
          folders={root.folders}
          files={root.files}
          section={section}
          contactId={clientId}
          currentPath="/"
          onNavigateToFolder={(name) => onEnterSection(section, `/${name}/`)}
          // Both open verbs enter the section first (see `onPreviewFile`).
          onPreview={openFile}
          onOpenFullScreen={canOpenFullScreen ? openFile : undefined}
          drag={drag}
        />
      )}
    </>
  );
}
