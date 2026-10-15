import { useEffect, useMemo, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, FileText, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { contactDisplayName, listContacts } from '@/api/contacts';
import { listHousehold } from '@/api/contactRelationships';
import { queryKeys } from '@/api/queryKeys';
import { useAuth } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-mobile';
import { getErrorMessage } from '@/lib/errors';
import { toast } from '@/components/ui/sonner';
import { PageHeader, SIDE_BAR_W } from '@/components/layout/page';
import { runBulk } from '../lib/bulkRun';
import { childPath } from '../lib/folderPath';
import { validateUploadFiles } from '../lib/documentNames';
import {
  documentKeys,
  folderChildCounts as fetchFolderChildCounts,
  folderKeys,
  getContactIdsWithDocuments,
  getUnreviewedDetailed,
  listDocumentsAtPath,
  listFoldersAtPath,
  markFolderAndContentsReviewed,
  setDocumentReviewed,
  setFolderReviewed,
} from '../api';
import { useExplorerState, type Section } from './useExplorerState';
import { useExplorerActions } from './useExplorerActions';
import { sharedWithName } from './sharedWith';
import type { ExplorerContact, ClientDocument, ClientFolder } from './types';
import { selectDocumentTreeContacts } from './selectDocumentTreeContacts';
import { unreviewedPrefixCounts, countsByFolderId } from './unreviewedDescendantCounts';
import { partitionSelection } from './selectionPartition';
import FolderTree from './FolderTree';
import FileGrid, { type RowActions } from './FileGrid';
import ExplorerBreadcrumb from './ExplorerBreadcrumb';
import ExplorerToolbar from './ExplorerToolbar';
import { cn } from '@/lib/utils';
import UploadDropZone from './UploadDropZone';
import { CreateButtons } from './ExplorerToolbar';
import UploadProgressBar from './UploadProgressBar';
import DocumentViewer from '../viewer/DocumentViewer';
import RenameDialog from './RenameDialog';
import MoveDialog from './MoveDialog';
import MoveToSharedDialog from './MoveToSharedDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import BulkDeleteConfirmDialog from './BulkDeleteConfirmDialog';
import BulkMoveDialog from './BulkMoveDialog';
import NewFolderDialog from './NewFolderDialog';
import ClientOverviewPane, { useSectionRoot, NO_FOLDERS, NO_FILES } from './ClientOverviewPane';
import ShareDocumentDialog, { type ShareTarget } from './ShareDocumentDialog';

// Lazy: pulls pdf.js and the annotation surface only when the owner opens a document.
const DocumentWorkstation = lazy(() => import('../workstation/DocumentWorkstation'));

export type { ExplorerContact } from './types';

export default function AdminDocumentsExplorer({
  initialClientId,
  lockedClient,
  variant = 'card',
}: {
  initialClientId?: string;
  /**
   * Scope the whole explorer to ONE contact: the contact record's Documents tab
   * mounts it this way so a contact shows the same hierarchy, the same two
   * sections and the same tools as the full explorer, rather than a flat
   * read-only list.
   *
   * It takes the CONTACT, not an id, and that is load-bearing. The roster the
   * contact index normally shows is `selectDocumentTreeContacts`, which keeps
   * clients plus anyone who already holds a file, so a lead with no documents
   * is not in it, an id would match nothing, and the tab would render an empty
   * index with no way to upload a first file. Passing the row makes the roster
   * unconditional, and both roster queries are skipped: a contact tab has no
   * reason to fetch every contact or the has-documents index.
   */
  lockedClient?: ExplorerContact;
  /**
   * `flush` for the full page, `card` (the default) inside a workspace tab.
   * See the root element for why the two differ.
   */
  variant?: 'card' | 'flush';
}) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const state = useExplorerState();
  const actions = useExplorerActions();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bulkDelete, setBulkDelete] = useState<{
    files: { id: string; held_by: Section }[];
    folders: { id: string; name: string }[];
  } | null>(null);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [workstationDocId, setWorkstationDocId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  // Phones keep the inline flow: the workstation is a desk and tablet surface.
  const canWorkstation = !useIsMobile();

  const hasFolderSelected = !!state.selectedClientId && !!state.activeSection;
  const hasClientOverview = !!state.selectedClientId && !state.activeSection;

  // The one thing the contact root cannot read off a row: where a NEW folder
  // or upload goes. The toolbar asks which section, and the answer is held here
  // until the dialog or the file picker consumes it. Inside a section the
  // active one wins and this is never read.
  const [rootSection, setRootSection] = useState<Section>('owner');
  const targetSection: Section = state.activeSection ?? rootSection;

  // --- Data queries ---

  const { data: allContacts = [] } = useQuery({
    queryKey: queryKeys.contacts.list(),
    queryFn: listContacts,
    enabled: !lockedClient,
  });

  // Contacts who still hold files, even after they leave 'client' status (moved
  // to one-time, say), so their documents never vanish from the index.
  const { data: contactIdsWithDocs = [] } = useQuery({
    queryKey: documentKeys.holders(),
    queryFn: getContactIdsWithDocuments,
    enabled: !lockedClient,
  });

  const clientContacts = useMemo(
    () =>
      lockedClient
        ? [lockedClient]
        : selectDocumentTreeContacts(allContacts, contactIdsWithDocs),
    [lockedClient, allContacts, contactIdsWithDocs]
  );

  // Same roster the index shows, flattened for the workstation's client switcher.
  const workstationClients = useMemo(
    () =>
      clientContacts.map((c) => ({
        id: c.id,
        name: contactDisplayName(c),
      })),
    [clientContacts],
  );

  // Deep link (?contact=): preselect that contact once contacts load. A locked
  // contact uses the same path: it is the same job, and it is what opens on the
  // contact instead of on a picker.
  const preselectClientId = lockedClient?.id ?? initialClientId;
  const initialClientAppliedRef = useRef(false);
  const { selectClient } = state;
  useEffect(() => {
    if (initialClientAppliedRef.current || !preselectClientId) return;
    const match = clientContacts.find((c) => c.id === preselectClientId);
    if (!match) return;
    initialClientAppliedRef.current = true;
    selectClient(match.id, contactDisplayName(match));
  }, [preselectClientId, clientContacts, selectClient]);

  // Folders at current path
  const { data: folders = NO_FOLDERS, isLoading: foldersLoading } = useQuery({
    queryKey: folderKeys.atPath(state.selectedClientId ?? '', state.currentPath, state.activeSection || 'owner'),
    queryFn: () => listFoldersAtPath(state.selectedClientId!, state.currentPath, state.activeSection || 'owner'),
    enabled: !!state.selectedClientId && !!state.activeSection,
  });

  // Files at current path
  const { data: files = NO_FILES, isLoading: filesLoading } = useQuery({
    queryKey: documentKeys.atPath(state.selectedClientId ?? '', state.currentPath, state.activeSection || 'owner'),
    queryFn: () => listDocumentsAtPath(state.selectedClientId!, state.currentPath, state.activeSection || 'owner'),
    enabled: !!state.selectedClientId && !!state.activeSection,
  });

  // The contact root draws both sections at `/`. Read here as well as in the
  // pane so the bulk bar, the Shared badges and the review handlers see the
  // rows on screen; `folders`/`files` above are disabled at the root.
  const sharedRoot = useSectionRoot(state.selectedClientId, 'owner', hasClientOverview);
  const clientRoot = useSectionRoot(state.selectedClientId, 'client', hasClientOverview);
  const visibleFolders = useMemo(
    () => (hasClientOverview ? [...sharedRoot.folders, ...clientRoot.folders] : folders),
    [hasClientOverview, sharedRoot.folders, clientRoot.folders, folders],
  );
  const visibleFiles = useMemo(
    () => (hasClientOverview ? [...sharedRoot.files, ...clientRoot.files] : files),
    [hasClientOverview, sharedRoot.files, clientRoot.files, files],
  );

  // Folder child counts
  const folderChildPaths = useMemo(
    () => folders.map((f) => childPath(state.currentPath, f.name)),
    [folders, state.currentPath],
  );
  const { data: folderChildCounts } = useQuery({
    queryKey: folderKeys.childCounts(state.selectedClientId ?? '', folderChildPaths, state.activeSection || 'owner'),
    queryFn: () => fetchFolderChildCounts(state.selectedClientId!, folderChildPaths, state.activeSection || 'owner'),
    enabled: !!state.selectedClientId && !!state.activeSection && folderChildPaths.length > 0,
  });

  // Per-folder-path count of unreviewed descendants (client section only).
  // Drives "N to review" on folder rows in FileGrid, so the owner sees at a
  // glance which folders to drill into. A folder may already be marked reviewed
  // while its contents are not; that case is exactly the one surfaced here.
  const { data: unreviewedDetailed = {} } = useQuery({
    queryKey: documentKeys.unreviewedDetailed(),
    queryFn: getUnreviewedDetailed,
    refetchInterval: 30000,
  });
  // Bucketed once per unreviewed-set change rather than compared per folder:
  // see `unreviewedDescendantCounts.ts` for why, and for the test that pins the
  // equivalence. Split into two memos on purpose: the expensive half depends
  // only on the fetched set, so navigating between folders no longer rebuilds it.
  const prefixCounts = useMemo(
    () => unreviewedPrefixCounts(
      state.activeSection === 'client' && state.selectedClientId
        ? unreviewedDetailed[state.selectedClientId]
        : undefined,
    ),
    [state.activeSection, state.selectedClientId, unreviewedDetailed],
  );

  const unreviewedDescendantCounts = useMemo(
    () => countsByFolderId(prefixCounts, folders, state.currentPath),
    [prefixCounts, folders, state.currentPath],
  );

  const isLoading = foldersLoading || filesLoading;

  // --- Handlers ---

  const handleUploadFiles = useCallback(async (uploadedFiles: File[]) => {
    if (!state.selectedClientId) return;

    // The browser's check spares a refused upload; the server checks every file again.
    const { accepted: validFiles, rejected } = await validateUploadFiles(uploadedFiles);
    if (rejected.length > 0) {
      toast.error(`${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped`, {
        description: rejected.map((r) => `${r.file.name}: ${r.reason}`).join('. '),
      });
    }
    if (validFiles.length === 0) return;

    state.setUploadProgress({ uploading: true, totalFiles: validFiles.length, completedFiles: 0, currentFileName: validFiles[0].name });
    try {
      await actions.uploadFiles(
        validFiles,
        state.selectedClientId,
        'general',
        state.currentPath,
        targetSection,
        (progress) => {
          state.setUploadProgress({
            uploading: true,
            totalFiles: progress.totalFiles,
            completedFiles: progress.completedFiles,
            currentFileName: progress.currentFileName,
          });
        }
      );
    } catch {
      // actions.uploadFiles already toasted (and rethrows so a caller that
      // wants the failure can see it); this catch exists only so the
      // rejection does not go unhandled here: neither the drop zone's onDrop
      // nor the file input's onChange awaits or catches this call.
    } finally {
      setTimeout(() => state.setUploadProgress(null), 1500);
    }
  }, [state.selectedClientId, targetSection, state.currentPath, actions, state]);

  /**
   * Clicking a file lands in the workstation: the contact index and the file grid stay the fast way to FIND a document, but picking
   * one puts you in the surface you work in, rather than a preview you then
   * have to escalate.
   *
   * `previewTarget` is still set: it is the explorer's notion of "current file"
   * and feeds the review toggle, the mobile overlay and the no-arg workstation
   * open. Phones fall back to that inline flow, since the workstation closes
   * itself below tablet width and would otherwise flash open and dismiss.
   */
  const handlePreview = useCallback((file: ClientDocument) => {
    state.setPreviewTarget({
      id: file.id,
      name: file.original_filename,
      mimeType: file.mime_type,
      reviewedAt: file.reviewed_at ?? null,
      folderPath: file.folder_path,
    });
    if (canWorkstation) setWorkstationDocId(file.id);
  }, [state, canWorkstation]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) void handleUploadFiles(selected);
    e.target.value = '';
  };

  const handleNavigateToFolder = useCallback((folderName: string) => {
    state.navigateToPath(childPath(state.currentPath, folderName));
  }, [state.currentPath, state.navigateToPath]);

  // Bulk action helpers
  const selectedFileItems = useMemo(
    () => visibleFiles.filter(f => state.selectedItems.has(f.id)),
    [visibleFiles, state.selectedItems]
  );
  const selectedFolderItems = useMemo(
    () => visibleFolders.filter(f => state.selectedItems.has(f.id)),
    [visibleFolders, state.selectedItems]
  );
  const selectedCount = selectedFileItems.length + selectedFolderItems.length;
  // Which section the selection sits on, and which of its rows are client-held.
  // Both come from one partition; the rules behind them are in the module.
  const {
    clientFiles: selectedClientFiles,
    clientFolders: selectedClientFolders,
    heldBy: selectionHeldBy,
  } = useMemo(
    () => partitionSelection(selectedFolderItems, selectedFileItems),
    [selectedFolderItems, selectedFileItems],
  );
  const selectedClientCount = selectedClientFiles.length + selectedClientFolders.length;

  const handleBulkDownload = useCallback(async () => {
    for (const file of selectedFileItems) {
      await actions.downloadFile({ id: file.id, filename: file.original_filename, mimeType: file.mime_type });
    }
  }, [selectedFileItems, actions]);

  const handleBulkMoveToShared = useCallback(async () => {
    if (!state.selectedClientId) return;
    const docIds = selectedClientFiles.map((f: ClientDocument) => f.id);
    if (docIds.length === 0) return;
    await actions.bulkMoveToShared(docIds, state.selectedClientId);
    state.clearSelection();
  }, [selectedClientFiles, state.selectedClientId, actions, state]);

  const handleBulkReview = useCallback(async () => {
    if (!userId || !state.selectedClientId) return;
    const unreviewedFiles = selectedClientFiles.filter((f: ClientDocument) => !f.reviewed_at);
    const unreviewedFolders = selectedClientFolders.filter((f: ClientFolder) => !f.reviewed_at);
    if (unreviewedFiles.length === 0 && unreviewedFolders.length === 0) {
      toast('Every selected item is already reviewed.');
      return;
    }
    // Optimistic update. At the contact root `activeSection` is null and
    // `currentPath` is `/`, so `|| 'client'` lands on exactly the key the
    // overview's uploads half reads, and only client-held rows carry review
    // state, so that is the only cache that needs touching there.
    const filesCacheKey = documentKeys.atPath(state.selectedClientId, state.currentPath, state.activeSection || 'client');
    const foldersCacheKey = folderKeys.atPath(state.selectedClientId, state.currentPath, state.activeSection || 'client');
    const reviewUpdate = { reviewed_at: new Date().toISOString(), reviewed_by: userId };
    const unreviewedFileIds = new Set(unreviewedFiles.map((f: ClientDocument) => f.id));
    const unreviewedFolderIds = new Set(unreviewedFolders.map((f: ClientFolder) => f.id));
    queryClient.setQueryData(filesCacheKey, (old: ClientDocument[] | undefined) =>
      old?.map(f => unreviewedFileIds.has(f.id) ? { ...f, ...reviewUpdate } : f)
    );
    queryClient.setQueryData(foldersCacheKey, (old: ClientFolder[] | undefined) =>
      old?.map(f => unreviewedFolderIds.has(f.id) ? { ...f, ...reviewUpdate } : f)
    );
    // Through runBulk (not Promise.all) so one failing item does not discard
    // the outcome of every other item in the selection: the tally below
    // reflects what actually happened, same as the other bulk operations.
    const bulkItems: Array<{ kind: 'file' | 'folder'; id: string }> = [
      ...unreviewedFiles.map((f: ClientDocument) => ({ kind: 'file' as const, id: f.id })),
      ...unreviewedFolders.map((f: ClientFolder) => ({ kind: 'folder' as const, id: f.id })),
    ];
    const result = await runBulk(bulkItems, (item) =>
      item.kind === 'file'
        ? setDocumentReviewed(item.id, true, userId)
        : setFolderReviewed(item.id, true, userId),
    );
    if (result.failed === 0) {
      toast.success(`${result.ok} item${result.ok === 1 ? '' : 's'} marked reviewed.`);
    } else {
      // A partial failure means the optimistic write above is wrong for
      // whichever items did not land: resync both caches.
      void queryClient.invalidateQueries({ queryKey: filesCacheKey });
      void queryClient.invalidateQueries({ queryKey: foldersCacheKey });
      toast.error(`${result.failed} of ${result.ok + result.failed} items failed`, {
        description: `${result.ok} marked reviewed. ${getErrorMessage(result.firstError)}`,
      });
    }
    actions.invalidateReviewCaches();
    // Contact-scoped caches (incl. the workstation rail): the optimistic
    // setQueryData above only touches the atPath key.
    if (state.selectedClientId) actions.invalidateAll(state.selectedClientId);
    state.clearSelection();
  }, [userId, state.selectedClientId, state.currentPath, state.activeSection, selectedClientFiles, selectedClientFolders, queryClient, actions, state.clearSelection]);

  const handleBulkDeleteRequest = useCallback(() => {
    const fileTargets = selectedFileItems.map((f: ClientDocument) => ({ id: f.id, held_by: f.held_by }));
    const folderTargets = selectedFolderItems.map((f: ClientFolder) => ({ id: f.id, name: f.name }));
    setBulkDelete({ files: fileTargets, folders: folderTargets });
  }, [selectedFileItems, selectedFolderItems]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (!bulkDelete || !state.selectedClientId) return;
    if (bulkDelete.files.length > 0) {
      await actions.bulkDeleteFiles(bulkDelete.files, state.selectedClientId);
    }
    if (bulkDelete.folders.length > 0) {
      await actions.bulkDeleteFolders(bulkDelete.folders, state.selectedClientId);
    }
    state.clearSelection();
  }, [bulkDelete, state.selectedClientId, actions, state]);

  // --- Review toggle handler (files + folders) ---
  // Cache keys resolve through `activeSection || 'client'` at `currentPath`,
  // which at the contact root is the overview's uploads key: the only section
  // whose rows can be toggled. Same reasoning as handleBulkReview. A failure
  // puts the optimistic row back (the snapshot) before the refetch.
  const handleToggleReview = useCallback(async (itemId: string, currentlyReviewed: boolean, itemType: 'file' | 'folder' = 'file') => {
    if (!userId || !state.selectedClientId) return;
    const contactId = state.selectedClientId;
    const reviewUpdate = {
      reviewed_at: currentlyReviewed ? null : new Date().toISOString(),
      reviewed_by: currentlyReviewed ? null : userId,
    };
    const filesCacheKey = documentKeys.atPath(contactId, state.currentPath, state.activeSection || 'client');
    const foldersCacheKey = folderKeys.atPath(contactId, state.currentPath, state.activeSection || 'client');
    if (itemType === 'folder') {
      const before = queryClient.getQueryData<ClientFolder[]>(foldersCacheKey);
      queryClient.setQueryData(foldersCacheKey, (old: ClientFolder[] | undefined) =>
        old?.map(f => f.id === itemId ? { ...f, ...reviewUpdate } : f)
      );
      try {
        if (!currentlyReviewed) {
          // Approving cascades to every subfolder and document inside this tree.
          // Un-reviewing does not cascade, so a stray click cannot wipe the
          // reviews below it.
          const { foldersMarked, documentIds } = await markFolderAndContentsReviewed(itemId);
          const docs = documentIds.length;
          const subfolders = Math.max(0, foldersMarked - 1);
          toast.success(docs + subfolders > 0
            ? `Folder, ${docs} document${docs === 1 ? '' : 's'}${subfolders > 0 ? ` and ${subfolders} subfolder${subfolders === 1 ? '' : 's'}` : ''} marked reviewed.`
            : 'Folder marked reviewed.');
        } else {
          await setFolderReviewed(itemId, false, userId);
        }
      } catch (err) {
        queryClient.setQueryData(foldersCacheKey, before);
        toast.error('The review mark was not saved', { description: getErrorMessage(err) });
      }
      // A cascading review may have touched files on screen.
      void queryClient.invalidateQueries({ queryKey: filesCacheKey });
      void queryClient.invalidateQueries({ queryKey: foldersCacheKey });
    } else {
      const before = queryClient.getQueryData<ClientDocument[]>(filesCacheKey);
      queryClient.setQueryData(filesCacheKey, (old: ClientDocument[] | undefined) =>
        old?.map(f => f.id === itemId ? { ...f, ...reviewUpdate } : f)
      );
      try {
        await setDocumentReviewed(itemId, !currentlyReviewed, userId);
      } catch (err) {
        queryClient.setQueryData(filesCacheKey, before);
        toast.error('The review mark was not saved', { description: getErrorMessage(err) });
      }
    }
    actions.invalidateReviewCaches();
    // Contact-scoped caches (incl. the workstation rail): the optimistic
    // setQueryData above only touches the atPath key.
    actions.invalidateAll(contactId);
  }, [userId, state.selectedClientId, state.currentPath, state.activeSection, queryClient, actions]);

  // --- Review toggle for the document viewer (updates preview target state too) ---
  const handlePreviewToggleReview = useCallback(() => {
    if (!state.previewTarget) return;
    const currentlyReviewed = !!state.previewTarget.reviewedAt;
    void handleToggleReview(state.previewTarget.id, currentlyReviewed, 'file');
    state.setPreviewTarget({
      ...state.previewTarget,
      reviewedAt: currentlyReviewed ? null : new Date().toISOString(),
    });
  }, [state.previewTarget, handleToggleReview, state]);

  // --- Full-screen workstation (opens on the current preview target) ---
  // Linked people for the selected contact. Read here rather than in the row
  // so the grid can label a share ("Shared with [name]") without a second embed
  // on every document. The list is ONLY the candidate set and the label source:
  // it never implies access. Access comes solely from
  // `client_documents.shared_with_contact_id`, set one document at a time.
  const { data: clientLinks = [] } = useQuery({
    queryKey: queryKeys.contactRelationships.forContact(state.selectedClientId ?? ''),
    queryFn: () => listHousehold(state.selectedClientId!),
    enabled: !!state.selectedClientId,
  });

  const sharedWithNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of visibleFiles) {
      // `sharedWithName` owns the whole rule, including naming a share whose
      // recipient is no longer linked rather than dropping the badge. A linear
      // scan per row is fine: `clientLinks` is one contact's household.
      const name = sharedWithName(f.shared_with_contact_id, clientLinks);
      if (name) out[f.id] = name;
    }
    return out;
  }, [clientLinks, visibleFiles]);

  // The viewer names a document by id; the row it came from gives its name and type.
  const previewRef = state.previewTarget
    ? { id: state.previewTarget.id, filename: state.previewTarget.name, mimeType: state.previewTarget.mimeType ?? '' }
    : null;
  const downloadPreviewTarget = () => { if (previewRef) void actions.downloadFile(previewRef); };
  const loadPreviewTarget = (docId: string) =>
    actions.previewFile(previewRef && previewRef.id === docId ? previewRef : docId);

  const handleRequestShare = useCallback((file: ClientDocument) => {
    setShareTarget({
      id: file.id,
      name: file.original_filename,
      contactId: file.contact_id,
      sharedWithContactId: file.shared_with_contact_id ?? null,
    });
  }, []);

  const handleOpenWorkstation = useCallback((docId?: string) => {
    const id = docId ?? state.previewTarget?.id;
    if (!id || !state.selectedClientId) return;
    setWorkstationDocId(id);
  }, [state.previewTarget, state.selectedClientId]);

  const handleSelectClient = useCallback((clientId: string, clientName: string) => {
    state.selectClient(clientId, clientName);
    setSidebarOpen(false);
  }, [state]);

  // Overview-mode handlers: clicking a section header / folder / file should
  // navigate the user *into* that section so the existing toolbar + grid take
  // over. Folders pass their path so we land directly in the right place.
  const handleEnterSectionFromOverview = useCallback((section: Section, path?: string) => {
    if (!state.selectedClientId || !state.selectedClientName) return;
    state.selectFolder(state.selectedClientId, state.selectedClientName, section, path ?? '/');
  }, [state]);

  const handlePreviewFileFromOverview = useCallback((section: Section, file: ClientDocument) => {
    if (!state.selectedClientId || !state.selectedClientName) return;
    state.selectFolder(state.selectedClientId, state.selectedClientName, section, '/');
    state.setPreviewTarget({
      id: file.id,
      name: file.original_filename,
      mimeType: file.mime_type,
      reviewedAt: file.reviewed_at ?? null,
      folderPath: file.folder_path,
    });
    // Same rule as handlePreview: a file click is a file click wherever it
    // happens, and an overview row that previewed while a grid row went
    // full-screen would just read as inconsistent.
    if (canWorkstation) setWorkstationDocId(file.id);
  }, [state, canWorkstation]);

  // `FolderTree` is the CONTACT index: it chooses which contact, and nothing
  // else. The right pane owns the folders, so these three props are all it needs.
  const treeProps = {
    clients: clientContacts,
    selectedClientId: state.selectedClientId,
    onSelectClient: handleSelectClient,
  };

  // The row verbs, built once and spread into the folder view and the client
  // root alike; see `RowActions` for why none of them needs a section.
  const rowActions: RowActions = {
    onDownload: (f) => void actions.downloadFile({ id: f.id, filename: f.original_filename, mimeType: f.mime_type }),
    onPreview: handlePreview,
    onOpenFullScreen: canWorkstation ? (f) => handleOpenWorkstation(f.id) : undefined,
    onSetRenameTarget: state.setRenameTarget,
    onSetMoveTarget: state.setMoveTarget,
    onSetMoveToSharedTarget: state.setMoveToSharedTarget,
    onSetDeleteTarget: state.setDeleteTarget,
    onRequestShare: handleRequestShare,
    sharedWithNames,
    onMoveFile: (id, path, contactId) => void actions.moveFile(id, path, contactId),
    onMoveFolder: (id, path, contactId) => void actions.moveFolder(id, path, contactId),
    onToggleReview: (id, reviewed, type) => void handleToggleReview(id, reviewed, type),
    selectedItems: state.selectedItems,
    onToggleSelectItem: state.toggleSelectItem,
  };

  const toolbar = (
    <ExplorerToolbar
      activeSection={state.activeSection}
      onNewFolder={(section) => { setRootSection(section); state.setNewFolderOpen(true); }}
      onUploadClick={(section) => { setRootSection(section); fileInputRef.current?.click(); }}
      selectedCount={selectedCount}
      onBulkDelete={handleBulkDeleteRequest}
      onBulkDownload={selectedFileItems.length > 0 ? () => void handleBulkDownload() : undefined}
      onBulkMove={selectionHeldBy ? () => setBulkMoveOpen(true) : undefined}
      onBulkMoveToShared={selectedClientFiles.length > 0 ? () => void handleBulkMoveToShared() : undefined}
      onBulkReview={selectedClientCount > 0 ? () => void handleBulkReview() : undefined}
      onClearSelection={state.clearSelection}
      showCreate={variant === 'card'}
    />
  );

  const onNewFolder = (section: Section) => { setRootSection(section); state.setNewFolderOpen(true); };
  const onUploadClick = (section: Section) => { setRootSection(section); fileInputRef.current?.click(); };

  // The page header, full-page variant only: the title, how much is waiting
  // and for how many contacts, and the toolbar as the page's actions. It portals
  // into the shell's top bar, so the explorer below it keeps its full height.
  const unreviewedTotal = Object.values(unreviewedDetailed).reduce((n, d) => n + d.docs.length + d.folders.length, 0);
  const unreviewedClients = Object.values(unreviewedDetailed).filter((d) => d.docs.length + d.folders.length > 0).length;
  const header = variant === 'flush' && (
    <PageHeader
      title="Documents"
      subtitle={
        unreviewedTotal === 0
          ? 'Nothing unreviewed'
          : `${unreviewedTotal} unreviewed across ${unreviewedClients} ${unreviewedClients === 1 ? 'contact' : 'contacts'}`
      }
      actions={hasClientOverview || hasFolderSelected ? toolbar : undefined}
    />
  );

  // --- Right pane content (shared between desktop and mobile) ---
  const renderRightPaneContent = () => {
    if (!hasClientOverview && !hasFolderSelected) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <FileText className="w-10 h-10 text-muted-foreground mb-2" aria-hidden="true" />
          <p className="text-sm text-muted-foreground font-medium">Select a contact</p>
          <p className="text-xs text-muted-foreground mt-1">Choose a contact from the list to see their documents.</p>
        </div>
      );
    }

    // The file list is the same whether or not a document viewer is open
    // beneath it; only the wrapper (a resizable split or a plain pane) differs.
    const fileList = (
      <UploadDropZone enabled={hasFolderSelected} onDrop={handleUploadFiles}>
        <ScrollArea className="h-full">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label="Loading" />
            </div>
          ) : (
            <FileGrid
              {...rowActions}
              folders={folders}
              files={files}
              activeSection={state.activeSection}
              currentPath={state.currentPath}
              selectedClientId={state.selectedClientId!}
              folderChildCounts={folderChildCounts}
              unreviewedDescendantCounts={unreviewedDescendantCounts}
              onNavigateUp={state.navigateUp}
              onNavigateToFolder={handleNavigateToFolder}
              onSelectAll={state.selectAll}
              onClearSelection={state.clearSelection}
            />
          )}
        </ScrollArea>
      </UploadDropZone>
    );

    return (
      <div className="flex flex-col h-full">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={handleFileInputChange}
        />

        {/* Breadcrumb row, a 40px band. On the full page the toolbar sits in
            the shell's top bar instead (see `header` above), so this row is the breadcrumb alone; inside the workspace
            tab there is no top bar to portal into and the toolbar stays here. */}
        <div className="flex min-h-10 flex-shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-1">
          <ExplorerBreadcrumb
            clientName={state.selectedClientName || ''}
            activeSection={state.activeSection}
            currentPath={state.currentPath}
            onGoToClientRoot={state.goToClientRoot}
            onNavigateToBreadcrumb={state.navigateToBreadcrumb}
          />
          {variant === 'card' ? toolbar : state.activeSection && (
            <div className="flex shrink-0 items-center gap-2">
              <CreateButtons section={state.activeSection} onNewFolder={onNewFolder} onUploadClick={onUploadClick} />
            </div>
          )}
        </div>

        {/* Upload progress */}
        {state.uploadProgress && <UploadProgressBar progress={state.uploadProgress} />}

        {/* Contact root: both sections stacked, same grid, same row verbs. The
            drop-zone upload stays off here: a drop has no one destination. */}
        {hasClientOverview && state.selectedClientId ? (
          <div className="flex-1 min-h-0">
            <ClientOverviewPane
              {...rowActions}
              clientId={state.selectedClientId}
              shared={sharedRoot}
              client={clientRoot}
              onEnterSection={handleEnterSectionFromOverview}
              onPreviewFile={handlePreviewFileFromOverview}
              onNewFolder={variant === 'card' ? undefined : onNewFolder}
              onUploadClick={variant === 'card' ? undefined : onUploadClick}
              onSelectAll={state.selectAll}
              onClearSelection={state.clearSelection}
            />
          </div>
        ) : /* File list + optional document viewer split */
        state.previewTarget ? (
          <div className="flex-1 flex flex-col min-h-0">
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={25} minSize={15}>
                {fileList}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={75} minSize={30}>
                <DocumentViewer
                  docId={state.previewTarget.id}
                  name={state.previewTarget.name}
                  fallbackMimeType={state.previewTarget.mimeType}
                  onClose={() => state.setPreviewTarget(null)}
                  onDownload={downloadPreviewTarget}
                  onLoadPreview={loadPreviewTarget}
                  reviewedAt={state.activeSection === 'client' ? state.previewTarget.reviewedAt : undefined}
                  onToggleReview={state.activeSection === 'client' ? handlePreviewToggleReview : undefined}
                  onOpenWorkstation={() => handleOpenWorkstation()}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        ) : (
          <div className="flex-1 min-h-0">{fileList}</div>
        )}
      </div>
    );
  };

  return (
    <>
    {header}
    <div
      className={
        // `flush` is the full-page spelling: edge to edge, no card, because the
        // page around it is the owner shell: a fixed-height split with its own
        // compact bars, not a padded document. `card` is the workspace TAB,
        // where the explorer is one panel among several and the border is what
        // separates it from the tab strip above.
        variant === 'flush'
          ? 'bg-background overflow-hidden flex-1 flex flex-col h-full'
          : 'bg-card rounded-lg border border-border overflow-hidden flex-1 flex flex-col h-full'
      }
      style={{ minHeight: 0 }}
    >
      {/* Mobile: sheet trigger + content. The trigger is a CONTACT PICKER, so a
          locked explorer has nothing for it to pick; see the desktop block. */}
      <div className="lg:hidden flex flex-col h-full">
        {!lockedClient && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                  <Menu className="w-4 h-4" aria-hidden="true" />
                  <span className="max-w-[60vw] truncate">{state.selectedClientName || 'Select a contact'}</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Contacts</SheetTitle>
                <SheetDescription className="sr-only">Select a contact to manage their documents</SheetDescription>
                <FolderTree {...treeProps} />
              </SheetContent>
            </Sheet>
          </div>
        )}
        <div className="flex-1 min-h-0">
          {renderRightPaneContent()}
        </div>
        {/* Mobile document viewer overlay. Suppressed while the workstation is
            open: both are fixed inset-0 z-50, so in the 768-1023px band they
            would stack and closing the workstation would land on a second
            full-screen viewer instead of the grid. */}
        {state.previewTarget && !workstationDocId && (
          <div className="fixed inset-0 z-50 bg-card lg:hidden">
            <DocumentViewer
              docId={state.previewTarget.id}
              name={state.previewTarget.name}
              fallbackMimeType={state.previewTarget.mimeType}
              onClose={() => state.setPreviewTarget(null)}
              onDownload={downloadPreviewTarget}
              onLoadPreview={loadPreviewTarget}
              reviewedAt={state.activeSection === 'client' ? state.previewTarget.reviewedAt : undefined}
              onToggleReview={state.activeSection === 'client' ? handlePreviewToggleReview : undefined}
              onOpenWorkstation={() => handleOpenWorkstation()}
            />
          </div>
        )}
      </div>

      {/* Desktop: two columns, or one when the explorer is already scoped to a
          single contact.

          The index's job is choosing WHICH contact, and inside a contact record
          that choice is already made: locked, it would be a search box over a
          list of one. The folder HIERARCHY is not lost with it: the landing
          view is the contact overview, which lists both sections with every
          folder under each, and the breadcrumb walks back up from inside one. */}
      <div className="hidden lg:flex h-full">
        {lockedClient ? (
          <div className="h-full w-full min-w-0">{renderRightPaneContent()}</div>
        ) : (
          <div className="flex h-full w-full min-w-0">
            {/* The same fixed width as every owner side bar (SIDE_BAR_W). */}
            <div className={cn('h-full shrink-0 overflow-hidden', SIDE_BAR_W)}>
              <FolderTree {...treeProps} />
            </div>
            <div className="h-full min-w-0 flex-1">
              {renderRightPaneContent()}
            </div>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <RenameDialog
        target={state.renameTarget}
        onClose={() => state.setRenameTarget(null)}
        onRenameFile={actions.renameFile}
        onRenameFolder={actions.renameFolder}
      />
      <MoveDialog
        target={state.moveTarget}
        onClose={() => state.setMoveTarget(null)}
        onMoveFile={actions.moveFile}
        onMoveFolder={actions.moveFolder}
      />
      <MoveToSharedDialog
        target={state.moveToSharedTarget}
        onClose={() => state.setMoveToSharedTarget(null)}
        onMoveToShared={actions.moveToShared}
        onCopyToShared={actions.copyToShared}
      />
      <DeleteConfirmDialog
        target={state.deleteTarget}
        onClose={() => state.setDeleteTarget(null)}
        onDeleteFile={actions.deleteFile}
        onDeleteFolder={actions.deleteFolder}
      />
      <NewFolderDialog
        open={state.newFolderOpen}
        onClose={() => state.setNewFolderOpen(false)}
        onCreateFolder={actions.createFolder}
        contactId={state.selectedClientId || ''}
        currentPath={state.currentPath}
        heldBy={targetSection}
      />
      <BulkDeleteConfirmDialog
        open={!!bulkDelete}
        fileCount={bulkDelete?.files.length || 0}
        folderCount={bulkDelete?.folders.length || 0}
        sharedFileCount={bulkDelete?.files.filter(f => f.held_by === 'owner').length || 0}
        onConfirm={handleBulkDeleteConfirm}
        onClose={() => setBulkDelete(null)}
      />
      <ShareDocumentDialog target={shareTarget} onClose={() => setShareTarget(null)} />
      <BulkMoveDialog
        open={bulkMoveOpen}
        fileIds={selectedFileItems.map((f: ClientDocument) => f.id)}
        folderIds={selectedFolderItems.map((f: ClientFolder) => f.id)}
        contactId={state.selectedClientId || ''}
        // The dialog only opens on a single-sided selection (see `selectionHeldBy`);
        // the fallback is for the closed dialog's render, nothing else.
        heldBy={selectionHeldBy ?? targetSection}
        onClose={() => { setBulkMoveOpen(false); state.clearSelection(); }}
        onMoveFile={actions.moveFile}
        onMoveFolder={actions.moveFolder}
      />

      {/* Full-screen workstation (lazy: pulls pdf.js and the renderers only when opened) */}
      {workstationDocId && state.selectedClientId && (
        <Suspense fallback={null}>
          <DocumentWorkstation
            contactId={state.selectedClientId}
            contactName={state.selectedClientName || 'Contact'}
            initialDocId={workstationDocId}
            initialScope={{ kind: 'section', heldBy: state.activeSection || 'client' }}
            clients={workstationClients}
            onClientChange={(id, name) => state.selectClient(id, name)}
            // Clearing previewTarget too: a file click arms it (it feeds the
            // review toggle, the mobile overlay and the no-arg open), and the
            // explorer renders `previewTarget ? <preview> : <grid>`, so without
            // this, closing lands on the inline preview instead of the file list,
            // defeating the point of the back button.
            onClose={() => {
              setWorkstationDocId(null);
              state.setPreviewTarget(null);
            }}
          />
        </Suspense>
      )}
    </div>
    </>
  );
}
