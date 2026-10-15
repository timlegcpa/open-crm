import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { runBulk, type BulkResult } from '../lib/bulkRun';
import {
  copyToShared as apiCopyToShared,
  createFolder as apiCreateFolder,
  deleteDocument,
  documentKeys,
  downloadDocument,
  folderKeys,
  getDocument,
  moveDocument,
  moveFolder as apiMoveFolder,
  moveToShared as apiMoveToShared,
  previewDocument,
  removeFolder,
  renameDocument,
  renameFolder as apiRenameFolder,
  uploadDocument,
  writeAudit,
  type PreviewSource,
} from '../api';
import { refOf, type DocumentRef, type Section } from '../types';

/** A document is named by its ref when the caller has the row, by id when it does not. */
export type DocumentOrId = string | DocumentRef;

async function resolveRef(doc: DocumentOrId): Promise<DocumentRef> {
  if (typeof doc !== 'string') return doc;
  const row = await getDocument(doc);
  if (!row) throw new Error('The file is no longer there.');
  return refOf(row);
}

/**
 * Every write the owner's explorer and workstation make, each one toasting its own
 * outcome and refreshing the caches it touched. A delete removes the ROW only: the
 * storage object is never removed from the browser (see api.ts).
 */
export function useExplorerActions() {
  const queryClient = useQueryClient();

  const invalidateAll = useCallback((contactId?: string) => {
    if (contactId) {
      void queryClient.invalidateQueries({ queryKey: documentKeys.pathForContact(contactId) });
      // The workstation rail. NOT covered by the 'path' prefix, so a stale rail would
      // not heal itself on the next open.
      void queryClient.invalidateQueries({ queryKey: documentKeys.forContact(contactId) });
      void queryClient.invalidateQueries({ queryKey: folderKeys.pathForContact(contactId) });
      void queryClient.invalidateQueries({ queryKey: folderKeys.childCountsForContact(contactId) });
      // Every section's folder list for the move pickers (folderKeys.listAll's prefix).
      void queryClient.invalidateQueries({ queryKey: ['client-folders', 'all', contactId] });
      void queryClient.invalidateQueries({ queryKey: documentKeys.holders() });
    } else {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
      void queryClient.invalidateQueries({ queryKey: folderKeys.all });
    }
  }, [queryClient]);

  // The owner-wide unreviewed rollups (the nav badge, the contact index marks). Kept
  // apart from invalidateAll so rename and move do not refetch them; review writes do.
  const invalidateReviewCaches = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.unreviewed });
  }, [queryClient]);

  const downloadFile = useCallback(async (doc: DocumentOrId) => {
    try {
      await downloadDocument(await resolveRef(doc));
    } catch (err: unknown) {
      toast.error('Download failed', { description: getErrorMessage(err) });
    }
  }, []);

  const previewFile = useCallback(async (doc: DocumentOrId): Promise<PreviewSource> => {
    try {
      return await previewDocument(await resolveRef(doc));
    } catch (err: unknown) {
      toast.error('Preview failed', { description: getErrorMessage(err) });
      throw err;
    }
  }, []);

  const renameFile = useCallback(async (docId: string, newName: string, contactId: string) => {
    try {
      await renameDocument(docId, newName);
      toast.success(`File renamed to "${newName}".`);
      invalidateAll(contactId);
    } catch (err: unknown) {
      toast.error('Rename failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll]);

  const renameFolder = useCallback(async (folderId: string, newName: string, contactId: string) => {
    try {
      await apiRenameFolder(folderId, newName);
      toast.success(`Folder renamed to "${newName}".`);
      invalidateAll(contactId);
    } catch (err: unknown) {
      toast.error('Rename failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll]);

  const moveFile = useCallback(async (docId: string, newPath: string, contactId: string) => {
    try {
      await moveDocument(docId, newPath);
      toast.success('File moved.');
      invalidateAll(contactId);
    } catch (err: unknown) {
      toast.error('Move failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll]);

  const moveFolder = useCallback(async (folderId: string, newParentPath: string, contactId: string) => {
    try {
      await apiMoveFolder(folderId, newParentPath);
      toast.success('Folder moved.');
      invalidateAll(contactId);
    } catch (err: unknown) {
      toast.error('Move failed', { description: getErrorMessage(err, 'Move failed.') });
    }
  }, [invalidateAll]);

  const moveToShared = useCallback(async (docId: string, folderPath: string, contactId: string) => {
    try {
      await apiMoveToShared(docId, folderPath);
      toast.success('Moved to shared documents.');
      invalidateAll(contactId);
      invalidateReviewCaches();
    } catch (err: unknown) {
      toast.error('Move failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll, invalidateReviewCaches]);

  const copyToShared = useCallback(async (docId: string, folderPath: string, contactId: string) => {
    try {
      await apiCopyToShared(docId, folderPath);
      toast.success('Copied to shared documents.');
      invalidateAll(contactId);
    } catch (err: unknown) {
      toast.error('Copy failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll]);

  const deleteFile = useCallback(async (docId: string, contactId: string) => {
    try {
      // The row only; deleteDocument also writes the owner's audit row.
      await deleteDocument(docId, 'owner');
      toast.success('File deleted.');
      invalidateAll(contactId);
      invalidateReviewCaches();
    } catch (err: unknown) {
      toast.error('Delete failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll, invalidateReviewCaches]);

  const deleteFolder = useCallback(async (folderId: string, folderName: string, contactId: string) => {
    try {
      const { documentsMoved } = await removeFolder(folderId);
      toast.success(
        documentsMoved > 0
          ? `Folder "${folderName}" removed. ${documentsMoved} file${documentsMoved === 1 ? '' : 's'} moved to the top level.`
          : `Folder "${folderName}" removed.`,
      );
      invalidateAll(contactId);
      invalidateReviewCaches();
      void writeAudit('folder_delete', { contact_id: contactId, folder_id: folderId });
    } catch (err: unknown) {
      toast.error('Delete failed', { description: getErrorMessage(err) });
    }
  }, [invalidateAll, invalidateReviewCaches]);

  const createFolder = useCallback(async (contactId: string, name: string, parentPath: string, heldBy: Section) => {
    try {
      await apiCreateFolder(contactId, name, parentPath, heldBy);
      toast.success(`Folder "${name}" created.`);
      invalidateAll(contactId);
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') toast.error('That folder already exists', { description: `A folder named "${name}" is already here.` });
      else toast.error('The folder was not created', { description: getErrorMessage(err) });
    }
  }, [invalidateAll]);

  const uploadFiles = useCallback(async (
    files: File[],
    contactId: string,
    category: string,
    folderPath: string,
    heldBy: Section,
    onProgress?: (progress: { completedFiles: number; totalFiles: number; currentFileName: string }) => void,
  ) => {
    try {
      for (let i = 0; i < files.length; i++) {
        onProgress?.({ completedFiles: i, totalFiles: files.length, currentFileName: files[i].name });
        await uploadDocument({ file: files[i], contactId, folderPath, heldBy, category });
      }
      onProgress?.({ completedFiles: files.length, totalFiles: files.length, currentFileName: '' });
      toast.success(`${files.length} file${files.length > 1 ? 's' : ''} uploaded.`);
      // The upload's activity row is written by the encrypt-document function.
    } catch (err: unknown) {
      toast.error('Upload failed', { description: getErrorMessage(err) });
      throw err;
    } finally {
      // Whatever landed before a failure is real; show it.
      invalidateAll(contactId);
    }
  }, [invalidateAll]);

  // The bulk operations go through runBulk, which guards each item on its own and
  // tallies the outcome, so the caches and the audit row reflect what happened.

  /** Toast the outcome: plain success, or an error naming how many failed. */
  const reportBulk = useCallback((result: BulkResult, noun: string, verb: string) => {
    if (result.failed === 0) {
      toast.success(`${result.ok} ${noun}${result.ok === 1 ? '' : 's'} ${verb}.`);
      return;
    }
    toast.error(`${result.failed} of ${result.ok + result.failed} ${noun}s failed`, {
      description: `${result.ok} ${verb}. ${getErrorMessage(result.firstError)}`,
    });
  }, []);

  const bulkDeleteFiles = useCallback(async (items: { id: string }[], contactId: string) => {
    const result = await runBulk(items, (item) => deleteDocument(item.id, 'owner'));
    reportBulk(result, 'file', 'deleted');
    invalidateAll(contactId);
    invalidateReviewCaches();
  }, [reportBulk, invalidateAll, invalidateReviewCaches]);

  const bulkDeleteFolders = useCallback(async (items: { id: string; name: string }[], contactId: string) => {
    const result = await runBulk(items, async (item) => { await removeFolder(item.id); });
    reportBulk(result, 'folder', 'deleted');
    invalidateAll(contactId);
    invalidateReviewCaches();
    // Count = what was actually removed, not what was selected.
    if (result.ok > 0) void writeAudit('folder_bulk_delete', { contact_id: contactId, count: result.ok });
  }, [reportBulk, invalidateAll, invalidateReviewCaches]);

  const bulkMoveToShared = useCallback(async (docIds: string[], contactId: string) => {
    const result = await runBulk(docIds, (id) => apiMoveToShared(id, '/'));
    reportBulk(result, 'document', 'moved to shared documents');
    invalidateAll(contactId);
    invalidateReviewCaches();
  }, [reportBulk, invalidateAll, invalidateReviewCaches]);

  return {
    // Exported so the workstation's review write refreshes the same caches the
    // explorer does, instead of listing the keys a second time.
    invalidateAll,
    invalidateReviewCaches,
    downloadFile,
    previewFile,
    renameFile,
    renameFolder,
    moveFile,
    moveFolder,
    moveToShared,
    copyToShared,
    deleteFile,
    deleteFolder,
    createFolder,
    uploadFiles,
    bulkDeleteFiles,
    bulkDeleteFolders,
    bulkMoveToShared,
  };
}
