import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderInput, FolderPlus, Loader2, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { EmptyState, PageHeader, Panel, Surface } from '@/components/layout/page';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { splitFilename } from '@/lib/format';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import {
  createFolder, deleteDocument, documentKeys, downloadDocument, folderChildCounts, folderKeys,
  listAllFolders, listDocumentsAtPath, listFoldersAtPath, listSharedWithMe, moveDocument,
  previewDocument, purgeFolder, renameDocument, renameFolder, uploadDocument,
} from '../api';
import { runBulk, type BulkResult } from '../lib/bulkRun';
import { childPath } from '../lib/folderPath';
import { validateName, validateUploadFiles } from '../lib/documentNames';
import { refOf, type ClientDocument, type ClientFolder, type Section } from '../types';
import type { UploadItem } from './types';
import { usePathNav } from './usePathNav';
import PortalDocsBreadcrumb from './PortalDocsBreadcrumb';
import PortalDocsGoUpRow from './PortalDocsGoUpRow';
import PortalDocsFolderRow from './PortalDocsFolderRow';
import PortalDocsFileRow from './PortalDocsFileRow';
import PortalDocsUploadBanner from './PortalDocsUploadBanner';
import {
  BulkDeleteDialog, BulkMoveDialog, DeleteFileDialog, DeleteFolderDialog, MoveDialog, NewFolderDialog,
  RenameDialog, type RenameTarget,
} from './PortalDocsDialogs';

// Lazy: the renderers (pdf, docx, csv) load only when a preview opens.
const DocumentViewer = lazy(() => import('../viewer/DocumentViewer'));

/** The in-page drag of a file row onto a folder (never a desktop file). */
const DRAG_TYPE = 'application/x-document-id';
const STALE_MS = 2 * 60 * 1000;

/** Notices are client-facing: an error's message is shown, never its internals. */
function failed(title: string, err: unknown) {
  toast.error(title, { description: getErrorMessage(err, 'Something went wrong. Try again.') });
}

function reportBulk(result: BulkResult, noun: string, verb: string) {
  const plural = (n: number) => `${n} ${noun}${n !== 1 ? 's' : ''}`;
  if (result.failed === 0) {
    toast.success(`${verb} ${plural(result.ok)}.`);
    return;
  }
  toast.error(`${plural(result.failed)} could not be ${verb.toLowerCase()}.`, {
    description: `${verb} ${plural(result.ok)}. ${getErrorMessage(result.firstError)}`,
  });
}

/** One section's current folder: its folders, its files and what each folder holds. */
function useSectionListing(contactId: string | null, path: string, heldBy: Section) {
  const enabled = !!contactId;
  const id = contactId ?? '';
  const folders = useQuery({
    queryKey: folderKeys.atPath(id, path, heldBy),
    queryFn: () => listFoldersAtPath(id, path, heldBy),
    enabled,
    staleTime: STALE_MS,
  });
  const files = useQuery({
    queryKey: documentKeys.atPath(id, path, heldBy),
    queryFn: () => listDocumentsAtPath(id, path, heldBy),
    enabled,
    staleTime: STALE_MS,
  });
  const folderPaths = useMemo(() => (folders.data ?? []).map((f) => childPath(path, f.name)), [folders.data, path]);
  const counts = useQuery({
    queryKey: folderKeys.childCounts(id, folderPaths, heldBy),
    queryFn: () => folderChildCounts(id, folderPaths, heldBy),
    enabled: enabled && folderPaths.length > 0,
    staleTime: STALE_MS,
  });
  return {
    folders: folders.data ?? [],
    files: files.data ?? [],
    counts: counts.data ?? {},
    loading: folders.isLoading || files.isLoading,
    error: folders.error ?? files.error,
  };
}

function ListMessage({ children, loading = false }: { children?: React.ReactNode; loading?: boolean }) {
  return (
    <li className="px-3.5 py-7 text-center text-[13px] text-muted-foreground">
      {loading ? <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading" /> : children}
    </li>
  );
}

export default function PortalDocuments() {
  const queryClient = useQueryClient();
  const { clientContactId: contactId } = useAuth();
  const { displayName: orgName } = usePublicBranding();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The owner's section ('owner', "Shared with you"): read-only here.
  const ownerNav = usePathNav('/');
  // The client's own section ('client', "Your uploads").
  const clientNav = usePathNav('/');
  const ownerPath = ownerNav.path;
  const clientPath = clientNav.path;

  const owner = useSectionListing(contactId, ownerPath, 'owner');
  const mine = useSectionListing(contactId, clientPath, 'client');

  // Documents of a related contact that were shared with this one: read-only, wherever filed.
  const { data: sharedDocs = [] } = useQuery({
    queryKey: documentKeys.sharedWithMe(contactId ?? ''),
    queryFn: () => listSharedWithMe(contactId ?? ''),
    enabled: !!contactId,
    staleTime: STALE_MS,
  });

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moveTarget, setMoveTarget] = useState<ClientDocument | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientDocument | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<ClientFolder | null>(null);
  const [previewDoc, setPreviewDoc] = useState<ClientDocument | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showBulkMove, setShowBulkMove] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const dragCounter = useRef(0);

  const { data: allFolders = [] } = useQuery({
    queryKey: folderKeys.listAll(contactId ?? '', 'client'),
    queryFn: () => listAllFolders(contactId ?? '', 'client'),
    enabled: !!contactId && (!!moveTarget || showBulkMove),
    staleTime: STALE_MS,
  });

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    void queryClient.invalidateQueries({ queryKey: folderKeys.all });
  }, [queryClient]);

  // --- Writes (all on the client's own section; RLS refuses anything else) ---

  const createFolderM = useMutation({
    mutationFn: (name: string) => createFolder(contactId ?? '', name, clientPath, 'client'),
    onSettled: invalidateAll,
  });
  const renameM = useMutation({
    mutationFn: ({ target, name }: { target: RenameTarget; name: string }) =>
      target.type === 'file' ? renameDocument(target.id, name) : renameFolder(target.id, name),
    onSettled: invalidateAll,
  });
  const moveM = useMutation({
    mutationFn: ({ id, dest }: { id: string; dest: string }) => moveDocument(id, dest),
    onSettled: invalidateAll,
  });
  // Removes the ROW only. The stored object is never deleted from the browser (api.ts).
  const deleteDocM = useMutation({
    mutationFn: (id: string) => deleteDocument(id, 'client'),
    onSettled: invalidateAll,
  });
  const purgeFolderM = useMutation({
    mutationFn: (id: string) => purgeFolder(id),
    onSettled: invalidateAll,
  });
  const uploadM = useMutation({
    mutationFn: (item: UploadItem) =>
      uploadDocument({ file: item.file, contactId: contactId ?? '', folderPath: item.targetPath, heldBy: 'client' }),
  });
  const bulkDeleteM = useMutation({
    mutationFn: async ({ files, folders }: { files: ClientDocument[]; folders: ClientFolder[] }) => {
      const a = await runBulk(files, (f) => deleteDocument(f.id, 'client'));
      const b = await runBulk(folders, (f) => purgeFolder(f.id));
      return { ok: a.ok + b.ok, failed: a.failed + b.failed, firstError: a.firstError ?? b.firstError };
    },
    onSettled: invalidateAll,
  });
  const bulkMoveM = useMutation({
    mutationFn: ({ files, dest }: { files: ClientDocument[]; dest: string }) => runBulk(files, (f) => moveDocument(f.id, dest)),
    onSettled: invalidateAll,
  });

  // --- Selection (the client's own section only) ---

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleIds = useMemo(() => [...mine.folders.map((f) => f.id), ...mine.files.map((f) => f.id)], [mine.folders, mine.files]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedFiles = useMemo(() => mine.files.filter((f) => selectedIds.has(f.id)), [mine.files, selectedIds]);
  const selectedFolders = useMemo(() => mine.folders.filter((f) => selectedIds.has(f.id)), [mine.folders, selectedIds]);
  const selectedCount = selectedFiles.length + selectedFolders.length;

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  // --- Uploads ---

  // Results are matched to queue items by the File object, never by index: the queue
  // accumulates across drops. Batches are chained so two drops run one after the other.
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());

  const runUploadBatch = useCallback(async (items: UploadItem[]) => {
    for (const item of items) {
      setUploadQueue((prev) => prev.map((it) => (it.file === item.file ? { ...it, status: 'uploading' } : it)));
      try {
        await uploadM.mutateAsync(item);
        setUploadQueue((prev) => prev.map((it) => (it.file === item.file ? { ...it, status: 'done' } : it)));
      } catch (err) {
        setUploadQueue((prev) => prev.map((it) => (it.file === item.file ? { ...it, status: 'error' } : it)));
        failed(`${item.file.name} was not uploaded`, err);
      }
    }
    invalidateAll();
    setTimeout(() => setUploadQueue((prev) => prev.filter((it) => it.status !== 'done')), 2000);
  }, [uploadM, invalidateAll]);

  const queueFiles = useCallback(async (fileList: File[], targetPath: string) => {
    const { accepted, rejected } = await validateUploadFiles(fileList);
    for (const r of rejected) toast.error(`Skipped ${r.file.name}`, { description: `Not uploaded: ${r.reason}.` });
    if (accepted.length === 0) return;
    const items: UploadItem[] = accepted.map((file) => ({ file, status: 'pending', targetPath }));
    setUploadQueue((prev) => [...prev, ...items]);
    const next = uploadChainRef.current.then(() => runUploadBatch(items));
    // One failed batch must never break the chain for the next drop.
    uploadChainRef.current = next.catch(() => {});
  }, [runUploadBatch]);

  const handleUploadClick = () => {
    if (!contactId) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files ?? []);
    if (fileList.length > 0) void queueFiles(fileList, clientPath);
    e.target.value = '';
  };

  // --- Drag and drop (the client's own section) ---

  const draggedFileIdRef = useRef<string | null>(null);
  draggedFileIdRef.current = draggedFileId;

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Clamped at 0: a dragleave without its dragenter (a browser quirk at the window edge)
    // must not leave the counter negative and the overlay stuck.
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setIsDragging(false);
      setFolderDropTarget(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    setFolderDropTarget(null);
    // An in-page file drag that ended outside a folder does nothing.
    if (draggedFileIdRef.current) {
      setDraggedFileId(null);
      return;
    }
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) void queueFiles(dropped, clientPath);
  };

  const handleFolderDragOver = useCallback((e: React.DragEvent, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = draggedFileIdRef.current ? 'move' : 'copy';
    setFolderDropTarget(folderName);
  }, []);

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderDropTarget(null);
  }, []);

  const handleFolderDrop = useCallback((e: React.DragEvent, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    setFolderDropTarget(null);
    const dest = childPath(clientPath, folderName);
    const draggedId = draggedFileIdRef.current;
    if (draggedId) {
      setDraggedFileId(null);
      moveM.mutateAsync({ id: draggedId, dest })
        .then(() => toast.success(`Moved to ${folderName}.`))
        .catch((err: unknown) => failed('The file was not moved', err));
      return;
    }
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) void queueFiles(dropped, dest);
  }, [clientPath, moveM, queueFiles]);

  const handleFileRowDragStart = useCallback((e: React.DragEvent<HTMLLIElement>, id: string) => {
    setDraggedFileId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, id);
  }, []);

  const handleFileRowDragEnd = useCallback(() => {
    setDraggedFileId(null);
    setFolderDropTarget(null);
    dragCounter.current = 0;
  }, []);

  // --- Row actions ---

  const handleDownload = useCallback(async (doc: ClientDocument) => {
    try {
      await downloadDocument(refOf(doc));
    } catch (err) {
      failed('The download did not start', err);
    }
  }, []);

  const handlePreview = useCallback((doc: ClientDocument) => {
    setPreviewDoc(doc);
    // The preview opens below the lists; bring it into view.
    requestAnimationFrame(() => {
      document.getElementById('portal-docs-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const handleFolderRename = useCallback((f: ClientFolder) => {
    setRenameTarget({ id: f.id, name: f.name, type: 'folder' });
    setRenameValue(f.name);
  }, []);

  const handleFileRename = useCallback((doc: ClientDocument) => {
    setRenameTarget({ id: doc.id, name: doc.original_filename, type: 'file' });
    setRenameValue(splitFilename(doc.original_filename).name);
  }, []);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !contactId || createFolderM.isPending) return;
    const nameErr = validateName(name, 100);
    if (nameErr) {
      toast.error('That name cannot be used', { description: nameErr });
      return;
    }
    try {
      await createFolderM.mutateAsync(name);
      setNewFolderName('');
      setShowNewFolder(false);
    } catch (err) {
      const raw = getErrorMessage(err);
      failed('The folder was not created', raw.includes('duplicate') ? new Error('A folder with that name is already here.') : err);
    }
  };

  const handleRenameSubmit = async () => {
    if (renameM.isPending || !renameTarget || !renameValue.trim()) return;
    const base = renameValue.trim();
    const name = renameTarget.type === 'file' ? base + splitFilename(renameTarget.name).ext : base;
    const nameErr = validateName(name, renameTarget.type === 'file' ? 255 : 100);
    if (nameErr) {
      toast.error('That name cannot be used', { description: nameErr });
      return;
    }
    try {
      await renameM.mutateAsync({ target: renameTarget, name });
      toast.success(`Renamed to ${name}.`);
      setRenameTarget(null);
    } catch (err) {
      failed('The name was not changed', err);
    }
  };

  const handleMoveSubmit = async (dest: string) => {
    if (!moveTarget) return;
    try {
      await moveM.mutateAsync({ id: moveTarget.id, dest });
      toast.success(`Moved ${moveTarget.original_filename}.`);
      setMoveTarget(null);
    } catch (err) {
      failed('The file was not moved', err);
    }
  };

  const handleDeleteFile = async () => {
    if (!deleteTarget) return;
    try {
      await deleteDocM.mutateAsync(deleteTarget.id);
      toast.success(`Deleted ${deleteTarget.original_filename}.`);
      if (previewDoc?.id === deleteTarget.id) setPreviewDoc(null);
      setDeleteTarget(null);
    } catch (err) {
      failed('The file was not deleted', err);
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    try {
      await purgeFolderM.mutateAsync(deleteFolderTarget.id);
      toast.success(`Deleted ${deleteFolderTarget.name}.`);
      setDeleteFolderTarget(null);
    } catch (err) {
      failed('The folder was not deleted', err);
    }
  };

  const handleBulkDelete = async () => {
    try {
      reportBulk(await bulkDeleteM.mutateAsync({ files: selectedFiles, folders: selectedFolders }), 'item', 'Deleted');
    } catch (err) {
      failed('Nothing was deleted', err);
    } finally {
      setSelectedIds(new Set());
      setShowBulkDelete(false);
    }
  };

  const handleBulkMove = async (dest: string) => {
    try {
      reportBulk(await bulkMoveM.mutateAsync({ files: selectedFiles, dest }), 'file', 'Moved');
    } catch (err) {
      failed('Nothing was moved', err);
    } finally {
      setSelectedIds(new Set());
      setShowBulkMove(false);
    }
  };

  if (!contactId) {
    return (
      <div className="min-w-0">
        <PageHeader title="Documents" />
        <EmptyState title="Your documents are not available" description="Sign out and sign in again. If this keeps happening, contact us." />
      </div>
    );
  }

  const ownerEmpty = owner.folders.length === 0 && owner.files.length === 0;
  const mineEmpty = mine.folders.length === 0 && mine.files.length === 0;

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-col gap-4">
        <PageHeader title="Documents" subtitle="Encrypted, and yours to download any time." />

        <PortalDocsUploadBanner
          fileInputRef={fileInputRef}
          orgName={orgName}
          uploadQueue={uploadQueue}
          onUploadClick={handleUploadClick}
          onFileInputChange={handleFileInputChange}
        />

        {/* The owner's section: read-only to the client. */}
        <Panel title="Shared with you">
          {ownerNav.inSubfolder && (
            <PortalDocsBreadcrumb pathParts={ownerNav.pathParts} navigateToIndex={ownerNav.navigateToIndex} homeLabel="Shared with you" />
          )}
          <ul aria-label="Shared with you">
            {ownerNav.inSubfolder && <PortalDocsGoUpRow onGoUp={ownerNav.goUp} />}
            {owner.loading ? (
              <ListMessage loading />
            ) : owner.error ? (
              <ListMessage>These documents could not be loaded. Refresh the page to try again.</ListMessage>
            ) : ownerEmpty ? (
              <ListMessage>{ownerNav.inSubfolder ? 'This folder is empty.' : `Nothing has been shared with you yet. Anything ${orgName ?? 'we'} share${orgName ? 's' : ''} appears here.`}</ListMessage>
            ) : (
              <>
                {owner.folders.map((folder) => (
                  <PortalDocsFolderRow
                    key={folder.id}
                    folder={folder}
                    childCounts={owner.counts[childPath(ownerPath, folder.name)]}
                    section="owner"
                    onOpen={ownerNav.openFolder}
                  />
                ))}
                {owner.files.map((file) => (
                  <PortalDocsFileRow
                    key={file.id}
                    file={file}
                    editable={false}
                    onPreview={handlePreview}
                    onDownload={handleDownload}
                  />
                ))}
              </>
            )}
          </ul>
        </Panel>

        {/* The client's own section. */}
        <Panel
          title="Your uploads"
          action={
            <>
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowNewFolder(true)}>
                <FolderPlus size={13} aria-hidden="true" /> New folder
              </Button>
              <Button size="sm" className="h-7 gap-1 text-xs" onClick={handleUploadClick}>
                <Upload size={13} aria-hidden="true" /> Upload
              </Button>
            </>
          }
        >
          <div onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
            {clientNav.inSubfolder && (
              <PortalDocsBreadcrumb pathParts={clientNav.pathParts} navigateToIndex={clientNav.navigateToIndex} homeLabel="Your uploads" />
            )}

            {visibleIds.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3.5 py-1.5">
                <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select everything in this folder" />
                <span className="text-[13px] text-muted-foreground">
                  {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
                </span>
                {selectedCount > 0 && (
                  <div className="ml-auto flex flex-wrap gap-2">
                    {selectedFiles.length > 0 && (
                      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowBulkMove(true)}>
                        <FolderInput size={13} aria-hidden="true" /> Move
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-destructive" onClick={() => setShowBulkDelete(true)}>
                      <Trash2 size={13} aria-hidden="true" /> Delete
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>
                      Clear
                    </Button>
                  </div>
                )}
              </div>
            )}

            {isDragging && !folderDropTarget && (
              <p className="pointer-events-none flex items-center justify-center gap-2 border-b border-dashed border-ring py-5 text-sm font-medium text-foreground">
                <Upload size={18} aria-hidden="true" /> Drop files here to upload
              </p>
            )}

            <ul aria-label="Your uploads">
              {clientNav.inSubfolder && <PortalDocsGoUpRow onGoUp={clientNav.goUp} />}
              {mine.loading ? (
                <ListMessage loading />
              ) : mine.error ? (
                <ListMessage>Your uploads could not be loaded. Refresh the page to try again.</ListMessage>
              ) : mineEmpty ? (
                <ListMessage>
                  {clientNav.inSubfolder ? 'This folder is empty. Drag files here or use Upload.' : 'Nothing uploaded yet. Use Upload, or drag files here.'}
                </ListMessage>
              ) : (
                <>
                  {mine.folders.map((folder) => (
                    <PortalDocsFolderRow
                      key={folder.id}
                      folder={folder}
                      childCounts={mine.counts[childPath(clientPath, folder.name)]}
                      section="client"
                      onOpen={clientNav.openFolder}
                      selected={selectedIds.has(folder.id)}
                      isDrop={folderDropTarget === folder.name}
                      onToggleSelect={toggleSelect}
                      onRename={handleFolderRename}
                      onDelete={setDeleteFolderTarget}
                      onFolderDragOver={handleFolderDragOver}
                      onFolderDragLeave={handleFolderDragLeave}
                      onFolderDrop={handleFolderDrop}
                    />
                  ))}
                  {mine.files.map((file) => (
                    <PortalDocsFileRow
                      key={file.id}
                      file={file}
                      editable
                      selected={selectedIds.has(file.id)}
                      isDragged={draggedFileId === file.id}
                      onToggleSelect={toggleSelect}
                      onPreview={handlePreview}
                      onDownload={handleDownload}
                      onRename={handleFileRename}
                      onMove={setMoveTarget}
                      onDelete={setDeleteTarget}
                      onDragStart={handleFileRowDragStart}
                      onDragEnd={handleFileRowDragEnd}
                    />
                  ))}
                </>
              )}
            </ul>
          </div>
        </Panel>

        {/* Another contact's documents, shared with this one: view and download only. */}
        {sharedDocs.length > 0 && (
          <Panel title="Shared from another account">
            <p className="border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
              Documents from a related account, shared with you to view and download.
            </p>
            <ul aria-label="Shared from another account">
              {sharedDocs.map((file) => (
                <PortalDocsFileRow key={file.id} file={file} editable={false} onPreview={handlePreview} onDownload={handleDownload} />
              ))}
            </ul>
          </Panel>
        )}

        {previewDoc && (
          <Surface padding={false} className="h-[75vh] min-h-[360px]">
            <div id="portal-docs-preview" className="h-full">
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>}>
                <DocumentViewer
                  docId={previewDoc.id}
                  name={previewDoc.original_filename}
                  fallbackMimeType={previewDoc.mime_type}
                  onClose={() => setPreviewDoc(null)}
                  onDownload={() => void handleDownload(previewDoc)}
                  onLoadPreview={() => previewDocument(refOf(previewDoc))}
                />
              </Suspense>
            </div>
          </Surface>
        )}

        <NewFolderDialog
          open={showNewFolder}
          onOpenChange={setShowNewFolder}
          name={newFolderName}
          onNameChange={setNewFolderName}
          onSubmit={handleCreateFolder}
          isCreating={createFolderM.isPending}
        />
        <RenameDialog
          target={renameTarget}
          value={renameValue}
          onValueChange={setRenameValue}
          onSubmit={handleRenameSubmit}
          onClose={() => setRenameTarget(null)}
          isSubmitting={renameM.isPending}
        />
        <MoveDialog
          target={moveTarget ? { id: moveTarget.id, name: moveTarget.original_filename } : null}
          allFolders={allFolders}
          currentPath={moveTarget?.folder_path ?? clientPath}
          moving={moveM.isPending}
          onSubmit={handleMoveSubmit}
          onClose={() => setMoveTarget(null)}
        />
        <DeleteFileDialog
          target={deleteTarget ? { name: deleteTarget.original_filename } : null}
          busy={deleteDocM.isPending}
          onConfirm={handleDeleteFile}
          onClose={() => setDeleteTarget(null)}
        />
        <DeleteFolderDialog
          target={deleteFolderTarget}
          busy={purgeFolderM.isPending}
          onConfirm={handleDeleteFolder}
          onClose={() => setDeleteFolderTarget(null)}
        />
        <BulkDeleteDialog
          open={showBulkDelete}
          count={selectedCount}
          busy={bulkDeleteM.isPending}
          onConfirm={handleBulkDelete}
          onClose={() => setShowBulkDelete(false)}
        />
        <BulkMoveDialog
          open={showBulkMove}
          fileCount={selectedFiles.length}
          allFolders={allFolders}
          currentPath={clientPath}
          moving={bulkMoveM.isPending}
          onSubmit={handleBulkMove}
          onClose={() => setShowBulkMove(false)}
        />
      </div>
    </TooltipProvider>
  );
}
