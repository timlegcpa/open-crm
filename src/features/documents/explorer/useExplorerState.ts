import { useState, useCallback, useRef } from 'react';
import { selectRange } from './selectRange';
import { Building2, User, type LucideIcon } from 'lucide-react';
import { parentOf } from '../lib/folderPath';
import { SECTIONS, type Section } from '../types';

export { SECTIONS, type Section };

/** The half the explorer is inside, or `null` at the client root. */
export type ActiveSection = Section | null;

/**
 * What the two halves are called wherever the explorer has to name them: the
 * client-root group rows and the toolbar's "which half?" menus. One spelling,
 * so the menu that asks where a new folder goes reads the same as the heading
 * it then appears under. (The breadcrumb keeps its own, longer vocabulary.)
 */
export const SECTION_LABEL: Record<Section, string> = {
  owner: 'Shared documents',
  client: 'Uploaded documents',
};

/**
 * The icon each half is drawn with. Kept beside the label so no call site hand-writes
 * `section === 'owner' ? Building2 : User` and drifts from the map.
 */
export const SECTION_ICON: Record<Section, LucideIcon> = {
  owner: Building2,
  client: User,
};

export interface DialogTarget {
  id: string;
  name: string;
  type: 'file' | 'folder';
  storagePath?: string;
  contactId?: string;
  heldBy?: string;
}

export interface PreviewTarget {
  id: string;
  name: string;
  mimeType?: string;
  reviewedAt?: string | null;
  // Source row's folder_path, carried here because overview-opened previews
  // (handlePreviewFileFromOverview) show docs the current atPath cache doesn't contain.
  folderPath: string;
}

export interface UploadProgress {
  uploading: boolean;
  totalFiles: number;
  completedFiles: number;
  currentFileName: string;
}

export interface ExplorerState {
  selectedClientId: string | null;
  selectedClientName: string | null;
  activeSection: ActiveSection;
  currentPath: string;
  // Dialog targets
  renameTarget: DialogTarget | null;
  moveTarget: DialogTarget | null;
  moveToSharedTarget: DialogTarget | null;
  deleteTarget: DialogTarget | null;
  newFolderOpen: boolean;
  previewTarget: PreviewTarget | null;
  uploadProgress: UploadProgress | null;
}

export function useExplorerState() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedClientName, setSelectedClientName] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ActiveSection>(null);
  const [currentPath, setCurrentPath] = useState('/');

  // Dialog states
  const [renameTarget, setRenameTarget] = useState<DialogTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<DialogTarget | null>(null);
  const [moveToSharedTarget, setMoveToSharedTarget] = useState<DialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DialogTarget | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  // Selection state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  // The last row clicked: a shift-click selects from here to the clicked row.
  const anchorRef = useRef<string | null>(null);
  // `order` (the rows as drawn) arrives only on a shift-click.
  const toggleSelectItem = useCallback((id: string, order?: readonly string[]) => {
    const anchor = anchorRef.current;
    anchorRef.current = id;
    setSelectedItems(prev => {
      if (order) return selectRange(prev, anchor, id, order);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedItems(new Set(ids));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedItems(new Set());
  }, []);

  const selectClient = useCallback((clientId: string, clientName: string) => {
    setSelectedClientId(clientId);
    setSelectedClientName(clientName);
    setActiveSection(null);
    setCurrentPath('/');
    setPreviewTarget(null);
    setSelectedItems(new Set());
  }, []);

  const enterSection = useCallback((section: Section) => {
    setActiveSection(section);
    setCurrentPath('/');
    setPreviewTarget(null);
    setSelectedItems(new Set());
  }, []);

  const selectFolder = useCallback((clientId: string, clientName: string, section: Section, path: string) => {
    setSelectedClientId(clientId);
    setSelectedClientName(clientName);
    setActiveSection(section);
    setCurrentPath(path);
    setPreviewTarget(null);
    setSelectedItems(new Set());
  }, []);

  const navigateToPath = useCallback((path: string) => {
    setCurrentPath(path);
    setPreviewTarget(null);
    setSelectedItems(new Set());
  }, []);

  const navigateUp = useCallback(() => {
    setPreviewTarget(null);
    setSelectedItems(new Set());
    if (currentPath === '/') {
      setActiveSection(null);
      return;
    }
    setCurrentPath(parentOf(currentPath));
  }, [currentPath]);

  const navigateToBreadcrumb = useCallback((index: number) => {
    setSelectedItems(new Set());
    // index -1 = root (section root), 0 = first segment, etc.
    if (index === -1) {
      setCurrentPath('/');
      return;
    }
    const segments = currentPath.split('/').filter(Boolean);
    const newPath = '/' + segments.slice(0, index + 1).join('/') + '/';
    setCurrentPath(newPath);
  }, [currentPath]);

  const goToClientRoot = useCallback(() => {
    setActiveSection(null);
    setCurrentPath('/');
    setSelectedItems(new Set());
  }, []);

  return {
    // State
    selectedClientId,
    selectedClientName,
    activeSection,
    currentPath,
    renameTarget,
    moveTarget,
    moveToSharedTarget,
    deleteTarget,
    newFolderOpen,
    previewTarget,
    uploadProgress,
    selectedItems,
    // Actions
    selectClient,
    selectFolder,
    enterSection,
    navigateToPath,
    navigateUp,
    navigateToBreadcrumb,
    goToClientRoot,
    setRenameTarget,
    setMoveTarget,
    setMoveToSharedTarget,
    setDeleteTarget,
    setNewFolderOpen,
    setPreviewTarget,
    setUploadProgress,
    toggleSelectItem,
    selectAll,
    clearSelection,
  };
}
