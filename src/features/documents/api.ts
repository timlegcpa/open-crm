/**
 * Every read and write of the documents feature: the rows (client_documents,
 * client_folders, document_annotations), the RPCs, and the two edge functions that carry
 * a file's bytes (encrypt-document in, decrypt-document out). Owner screens and the
 * portal share it; RLS decides what each session sees.
 *
 * Other features (requests, e-sign) use the exported functions here, never the tables:
 *   uploadDocument     file a new document (bytes checked and encrypted on the server)
 *   ensureFolderChain  make sure a folder path exists before filing into it
 *   getHeldBy          which section a document sits in right now
 *   links.documents(contactId) opens the explorer on a contact.
 *
 * Lists are read in keyset pages on `id` (never a silent 1,000-row cap) and sorted here.
 *
 * NEVER delete a documents-bucket object from here. One object can back more than one
 * row (a copy into the shared section shares it; an e-signed PDF is filed to every signer
 * over one object), and Storage is not transactional with Postgres, so "is any row still
 * pointing at it?" cannot be answered safely at delete time. A row delete strands the
 * object, which is the accepted state: the orphan report lists it and clearing is manual.
 */
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { fetchAllPaged, PAGE_SIZE, type PageResult } from '@/lib/pagedFetch';
import { downloadBlob } from '@/lib/download';
import { invokeEdge } from '@/lib/edge';
import { isAnnotationData, type AnnotationKind, type DocumentAnnotation } from './lib/annotations';
import { childPath } from './lib/folderPath';
import { savedFileName } from './lib/documentNames';
import type { ClientDocument, ClientFolder, DocumentRef, FolderPathRow, Section } from './types';

// ---------------------------------------------------------------------------
// Query keys. Every key starts with its table's name, so a whole family can be dropped.
// ---------------------------------------------------------------------------

export const documentKeys = {
  all: ['client-documents'] as const,
  /** Every listing of one contact's folder view. */
  pathForContact: (contactId: string) => ['client-documents', 'path', contactId] as const,
  atPath: (contactId: string, path: string, heldBy: Section) => ['client-documents', 'path', contactId, path, heldBy] as const,
  /** Every row of one contact (the viewer's rail). */
  forContact: (contactId: string) => ['client-documents', 'for-contact', contactId] as const,
  sharedWithMe: (contactId: string) => ['client-documents', 'shared-with-me', contactId] as const,
  /** The owner's unreviewed rollups: the nav badge, the per-contact counts, the per-folder marks. */
  unreviewed: ['client-documents', 'unreviewed'] as const,
  /** All contacts when `contactId` is omitted. */
  unreviewedCount: (contactId?: string) => ['client-documents', 'unreviewed', 'count', contactId ?? 'all'] as const,
  unreviewedDetailed: () => ['client-documents', 'unreviewed', 'detailed'] as const,
  holders: () => ['client-documents', 'holders'] as const,
};

export const folderKeys = {
  all: ['client-folders'] as const,
  pathForContact: (contactId: string) => ['client-folders', 'path', contactId] as const,
  atPath: (contactId: string, path: string, heldBy: Section) => ['client-folders', 'path', contactId, path, heldBy] as const,
  childCountsForContact: (contactId: string) => ['client-folders', 'child-counts', contactId] as const,
  childCounts: (contactId: string, paths: readonly string[], heldBy: Section) =>
    ['client-folders', 'child-counts', contactId, paths.join('|'), heldBy] as const,
  listAll: (contactId: string, heldBy: Section) => ['client-folders', 'all', contactId, heldBy] as const,
};

export const annotationKeys = {
  all: ['document-annotations'] as const,
  forDocument: (documentId: string) => ['document-annotations', documentId] as const,
};

// ---------------------------------------------------------------------------
// Paged reads
// ---------------------------------------------------------------------------

type Filter = (query: PagedQuery) => PagedQuery;
// The builder methods this module chains; supabase-js's own type is far wider.
interface PagedQuery {
  eq(column: string, value: unknown): PagedQuery;
  in(column: string, values: readonly unknown[]): PagedQuery;
  is(column: string, value: null): PagedQuery;
  gt(column: string, value: unknown): PagedQuery;
  order(column: string, options?: { ascending?: boolean }): PagedQuery;
  limit(n: number): PromiseLike<PageResult<never>>;
}

/** Every row of `table` matching `filter`, read in pages of 1,000 by id. */
function readAll<T extends { id: string }>(table: string, columns: string, filter: Filter): Promise<T[]> {
  return fetchAllPaged<T>((afterId) => {
    let query = filter(getSupabase().from(table).select(columns) as unknown as PagedQuery);
    if (afterId) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(PAGE_SIZE) as PromiseLike<PageResult<T>>;
  });
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const tieId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sortDocumentsByName(rows: ClientDocument[]): ClientDocument[] {
  return rows.sort((a, b) => byName(a.original_filename, b.original_filename) || tieId(a, b));
}

export function sortFoldersByName<T extends FolderPathRow>(rows: T[]): T[] {
  return rows.sort((a, b) => byName(a.name, b.name) || tieId(a, b));
}

const DOC_COLUMNS =
  'id, contact_id, uploaded_by, filename, original_filename, storage_path, file_size, mime_type, category, description, ' +
  'created_at, updated_at, folder_path, held_by, reviewed_at, reviewed_by, encryption_iv, encryption_status, shared_with_contact_id';
const FOLDER_COLUMNS = 'id, contact_id, parent_path, name, created_at, held_by, reviewed_at, reviewed_by';

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** Every document of one contact, both sections unless `heldBy`, newest first. */
export async function listDocumentsForContact(contactId: string, heldBy?: Section): Promise<ClientDocument[]> {
  const rows = await readAll<ClientDocument>('client_documents', DOC_COLUMNS, (q) => {
    const scoped = q.eq('contact_id', contactId);
    return heldBy ? scoped.eq('held_by', heldBy) : scoped;
  });
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : tieId(a, b)));
}

/**
 * The documents in one folder of one section, by name. The explicit contact filter is
 * load-bearing in the portal: the SELECT policy also matches documents SHARED with the
 * caller, and without it a document shared into the household would appear inside the
 * caller's own folder of the same path. Shared documents are listed by listSharedWithMe.
 */
export async function listDocumentsAtPath(contactId: string, folderPath: string, heldBy: Section): Promise<ClientDocument[]> {
  const rows = await readAll<ClientDocument>('client_documents', DOC_COLUMNS, (q) =>
    q.eq('contact_id', contactId).eq('folder_path', folderPath).eq('held_by', heldBy));
  return sortDocumentsByName(rows);
}

/** One document, or null when it is gone or not the caller's to read. */
export async function getDocument(documentId: string): Promise<ClientDocument | null> {
  const { data, error } = await getSupabase().from('client_documents').select(DOC_COLUMNS).eq('id', documentId).maybeSingle();
  if (error) throw error;
  return (data as unknown as ClientDocument | null) ?? null;
}

/** Another contact's documents that the owner shared with this contact, wherever they are filed. */
export async function listSharedWithMe(contactId: string): Promise<ClientDocument[]> {
  const rows = await readAll<ClientDocument>('client_documents', DOC_COLUMNS, (q) => q.eq('shared_with_contact_id', contactId));
  return sortDocumentsByName(rows);
}

/** Which section a document sits in right now, or null when the row is gone. */
export async function getHeldBy(documentId: string): Promise<Section | null> {
  const { data, error } = await getSupabase().from('client_documents').select('held_by').eq('id', documentId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (data as { held_by: string }).held_by === 'owner' ? 'owner' : 'client';
}

/** One write that must touch exactly the row asked for; zero rows means RLS refused or the row is gone. */
async function updateOne(table: 'client_documents' | 'client_folders', id: string, patch: Record<string, unknown>, what: string): Promise<void> {
  const { data, error } = await getSupabase().from(table).update(patch).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(`${what} was not saved. It may have been removed.`);
}

/**
 * Set (or clear, with null) the one contact a document is shared with: the ONLY thing
 * that lets a second person read a document. Per document and deliberate, never inferred
 * from a relationship; the recipient can read it and nothing more.
 */
export function setShare(documentId: string, sharedWithContactId: string | null): Promise<void> {
  return updateOne('client_documents', documentId, { shared_with_contact_id: sharedWithContactId }, 'The share');
}

/** Move a client's upload into the shared section (the owner only). */
export function moveToShared(documentId: string, folderPath = '/'): Promise<void> {
  return updateOne('client_documents', documentId, { held_by: 'owner', folder_path: folderPath }, 'The document');
}

/**
 * Copy a client's upload into the shared section. The copy points at the SAME storage
 * object (the bytes are never duplicated), which is why no delete path ever removes an
 * object. A share on the original never travels to the copy, and neither does its review.
 */
export async function copyToShared(documentId: string, folderPath = '/'): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('client_documents')
    .select('contact_id, filename, original_filename, storage_path, file_size, mime_type, category, description, encryption_iv, encryption_status')
    .eq('id', documentId)
    .single();
  if (error) throw error;
  const { error: insertError } = await supabase
    .from('client_documents')
    .insert({ ...(data as Record<string, unknown>), held_by: 'owner', folder_path: folderPath, shared_with_contact_id: null });
  if (insertError) throw insertError;
}

/** Mark a document reviewed or not. Takes the TARGET state, so pressing twice never undoes itself. */
export function setDocumentReviewed(documentId: string, reviewed: boolean, userId: string | null): Promise<void> {
  return updateOne(
    'client_documents', documentId,
    reviewed ? { reviewed_at: new Date().toISOString(), reviewed_by: userId } : { reviewed_at: null, reviewed_by: null },
    'The review mark',
  );
}

export function renameDocument(documentId: string, newName: string): Promise<void> {
  return rpc('client_document_rename', { p_document_id: documentId, p_new_name: newName });
}

export function moveDocument(documentId: string, folderPath: string): Promise<void> {
  return rpc('client_document_move', { p_document_id: documentId, p_new_folder_path: folderPath });
}

/**
 * Delete the document ROW, never its storage object (see the module header). RETURNING
 * proves RLS allowed it. A client's delete records a document_delete activity row; the
 * owner's records an audit row. Neither record can fail the delete.
 */
export async function deleteDocument(documentId: string, actor: 'owner' | 'client'): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('client_documents')
    .delete()
    .eq('id', documentId)
    .select('id, contact_id, original_filename');
  if (error) throw error;
  const row = (data as Array<{ id: string; contact_id: string; original_filename: string }> | null)?.[0];
  if (!row) throw new Error('The file was not deleted. It may already be gone, or it is not yours to delete.');
  if (actor === 'client') await recordClientDelete(row.contact_id, row.id, row.original_filename);
  else await writeAudit('document_delete', { contact_id: row.contact_id, document_id: row.id });
}

async function currentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user?.id ?? null;
}

/** The client's own document_delete row: only the keys its INSERT policy allows. Never throws. */
async function recordClientDelete(contactId: string, documentId: string, filename: string): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return;
    await getSupabase().from('client_activity_log').insert({
      contact_id: contactId,
      user_id: userId,
      action: 'document_delete',
      details: { document_id: documentId, filename: filename.slice(0, 255) },
    });
  } catch {
    // The row is already gone; a missing log line must not report the delete as failed.
  }
}

/** An owner audit row (audit_logs takes the owner's own user id only). Never throws. */
export async function writeAudit(action: string, details: Record<string, string | number | boolean | null>): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return;
    await getSupabase().from('audit_logs').insert({ user_id: userId, action, details });
  } catch {
    // Audit is a record of what happened; it must not undo what happened.
  }
}

// ---------------------------------------------------------------------------
// Unreviewed rollups (owner)
// ---------------------------------------------------------------------------

/** How many client uploads (files and folders) the owner has not reviewed. */
export async function getUnreviewedCount(contactId?: string): Promise<number> {
  const supabase = getSupabase();
  const count = async (table: string) => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('held_by', 'client').is('reviewed_at', null);
    if (contactId) query = query.eq('contact_id', contactId);
    const { count: n, error } = await query;
    if (error) throw error;
    return n ?? 0;
  };
  const [docs, folders] = await Promise.all([count('client_documents'), count('client_folders')]);
  return docs + folders;
}

export interface UnreviewedByContact {
  docs: Array<{ id: string; folder_path: string }>;
  folders: Array<{ id: string; name: string; parent_path: string }>;
}

/** Every unreviewed client upload, by contact, with where it sits (for per-folder marks). */
export async function getUnreviewedDetailed(): Promise<Record<string, UnreviewedByContact>> {
  const [docs, folders] = await Promise.all([
    readAll<{ id: string; contact_id: string; folder_path: string }>('client_documents', 'id, contact_id, folder_path', (q) =>
      q.eq('held_by', 'client').is('reviewed_at', null)),
    readAll<{ id: string; contact_id: string; name: string; parent_path: string }>('client_folders', 'id, contact_id, name, parent_path', (q) =>
      q.eq('held_by', 'client').is('reviewed_at', null)),
  ]);
  const out: Record<string, UnreviewedByContact> = {};
  const entry = (id: string) => (out[id] ??= { docs: [], folders: [] });
  for (const d of docs) entry(d.contact_id).docs.push({ id: d.id, folder_path: d.folder_path });
  for (const f of folders) entry(f.contact_id).folders.push({ id: f.id, name: f.name, parent_path: f.parent_path });
  return out;
}

/** Every contact holding a document or a folder, in either section. Paged like any list. */
export async function getContactIdsWithDocuments(): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    let query = getSupabase().rpc('get_contact_ids_with_documents').order('contact_id', { ascending: true }).limit(PAGE_SIZE);
    if (after) query = query.gt('contact_id', after);
    const { data, error } = await query;
    if (error) throw error;
    const page = ((data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id);
    ids.push(...page);
    if (page.length < PAGE_SIZE) return ids;
    after = page[page.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listFoldersAtPath(contactId: string, parentPath: string, heldBy: Section): Promise<ClientFolder[]> {
  const rows = await readAll<ClientFolder>('client_folders', FOLDER_COLUMNS, (q) =>
    q.eq('contact_id', contactId).eq('parent_path', parentPath).eq('held_by', heldBy));
  return sortFoldersByName(rows);
}

/** Every folder of one section, ordered as a tree reads (by full path), for the move pickers. */
export async function listAllFolders(contactId: string, heldBy: Section): Promise<FolderPathRow[]> {
  const rows = await readAll<FolderPathRow>('client_folders', 'id, name, parent_path', (q) =>
    q.eq('contact_id', contactId).eq('held_by', heldBy));
  return rows.sort((a, b) => byName(childPath(a.parent_path, a.name), childPath(b.parent_path, b.name)) || tieId(a, b));
}

export async function createFolder(contactId: string, name: string, parentPath: string, heldBy: Section): Promise<ClientFolder> {
  const { data, error } = await getSupabase()
    .from('client_folders')
    .insert({ contact_id: contactId, parent_path: parentPath, name, held_by: heldBy })
    .select(FOLDER_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as ClientFolder;
}

/** Make sure one folder exists; an existing one is left as it is. */
export async function ensureFolder(contactId: string, name: string, parentPath: string, heldBy: Section): Promise<void> {
  const { error } = await getSupabase()
    .from('client_folders')
    .upsert(
      { contact_id: contactId, parent_path: parentPath, name, held_by: heldBy },
      { onConflict: 'contact_id,parent_path,name,held_by', ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** Make sure every folder of `path` ('/a/b/') exists, top down. The database refuses a folder without its parent. */
export async function ensureFolderChain(contactId: string, path: string, heldBy: Section): Promise<void> {
  let parent = '/';
  for (const name of path.split('/').filter(Boolean)) {
    await ensureFolder(contactId, name, parent, heldBy);
    parent = childPath(parent, name);
  }
}

/** Rename a folder; everything under it follows (the database rewrites the paths). */
export function renameFolder(folderId: string, newName: string): Promise<void> {
  return rpc('rename_client_folder', { p_folder_id: folderId, p_new_name: newName });
}

/** Move a folder under another of its section (the owner only). */
export function moveFolder(folderId: string, newParentPath: string): Promise<void> {
  return rpc('move_client_folder', { p_folder_id: folderId, p_new_parent_path: newParentPath });
}

/** The owner's folder delete: the folders go, their documents move to the section's root. */
export async function removeFolder(folderId: string): Promise<{ foldersDeleted: number; documentsMoved: number }> {
  const { data, error } = await getSupabase().rpc('admin_client_folder_remove', { p_folder_id: folderId });
  if (error) throw error;
  const r = z.object({ folders_deleted: z.number(), documents_moved: z.number() }).parse(data);
  return { foldersDeleted: r.folders_deleted, documentsMoved: r.documents_moved };
}

/** The portal's folder delete: the folders and the document ROWS in them go; the objects stay. */
export function purgeFolder(folderId: string): Promise<void> {
  return rpc('portal_folder_purge', { p_folder_id: folderId });
}

export function setFolderReviewed(folderId: string, reviewed: boolean, userId: string | null): Promise<void> {
  return updateOne(
    'client_folders', folderId,
    reviewed ? { reviewed_at: new Date().toISOString(), reviewed_by: userId } : { reviewed_at: null, reviewed_by: null },
    'The review mark',
  );
}

/**
 * Mark a folder, its subfolders and every document in them reviewed, in one database
 * call. Only what is unreviewed is stamped; un-reviewing never cascades.
 */
export async function markFolderAndContentsReviewed(folderId: string): Promise<{ foldersMarked: number; documentIds: string[] }> {
  const { data, error } = await getSupabase().rpc('mark_client_folder_reviewed', { p_folder_id: folderId });
  if (error) throw error;
  const r = z.object({ folders_marked: z.number(), document_ids: z.array(z.string()) }).parse(data);
  return { foldersMarked: r.folders_marked, documentIds: r.document_ids };
}

export interface ChildCount {
  folders: number;
  files: number;
  lastModified: string | null;
}

/** What each folder in `paths` holds directly, and when that last changed. */
export async function folderChildCounts(contactId: string, paths: readonly string[], heldBy: Section): Promise<Record<string, ChildCount>> {
  const counts: Record<string, ChildCount> = {};
  for (const p of paths) counts[p] = { folders: 0, files: 0, lastModified: null };
  if (paths.length === 0) return counts;
  const [folders, files] = await Promise.all([
    readAll<{ id: string; parent_path: string; created_at: string }>('client_folders', 'id, parent_path, created_at', (q) =>
      q.eq('contact_id', contactId).eq('held_by', heldBy).in('parent_path', paths)),
    readAll<{ id: string; folder_path: string; created_at: string }>('client_documents', 'id, folder_path, created_at', (q) =>
      q.eq('contact_id', contactId).eq('held_by', heldBy).in('folder_path', paths)),
  ]);
  const touch = (entry: ChildCount | undefined, at: string) => {
    if (entry && (!entry.lastModified || at > entry.lastModified)) entry.lastModified = at;
  };
  for (const f of folders) {
    const entry = counts[f.parent_path];
    if (!entry) continue;
    entry.folders++;
    touch(entry, f.created_at);
  }
  for (const d of files) {
    const entry = counts[d.folder_path];
    if (!entry) continue;
    entry.files++;
    touch(entry, d.created_at);
  }
  return counts;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase().rpc(name, args);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// File bytes, through the edge functions
// ---------------------------------------------------------------------------

const uploadAnswer = z.object({ id: z.string(), filename: z.string() });
const redirectAnswer = z.object({
  mode: z.literal('redirect'),
  signed_url: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'not a web address'),
  filename: z.string(),
  mime_type: z.string(),
});

export interface UploadInput {
  file: File;
  contactId: string;
  folderPath: string;
  heldBy: Section;
  /** Free text, 'general' when omitted (requests pass their own category). */
  category?: string;
  description?: string;
}

/** Upload one file. The server checks its bytes against its type, encrypts it and files the row. */
export async function uploadDocument(input: UploadInput): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('contact_id', input.contactId);
  form.append('folder_path', input.folderPath);
  form.append('held_by', input.heldBy);
  form.append('category', input.category ?? 'general');
  if (input.description) form.append('description', input.description);
  return invokeEdge('encrypt-document', form, { parse: (d) => uploadAnswer.parse(d) });
}

export type FetchedDocument = { kind: 'bytes'; blob: Blob } | { kind: 'redirect'; url: string };

/**
 * A document's content. An encrypted document arrives as bytes (always sent as
 * octet-stream, retyped here from the row); a plaintext one (an e-signed PDF) as a short
 * signed link. A 'preview' is not logged; a 'download' is.
 */
export async function fetchDocument(doc: DocumentRef, purpose: 'preview' | 'download'): Promise<FetchedDocument> {
  const data = await invokeEdge<unknown>('decrypt-document', { document_id: doc.id, purpose });
  if (data instanceof Blob) return { kind: 'bytes', blob: new Blob([data], { type: doc.mimeType }) };
  const redirect = redirectAnswer.safeParse(data);
  if (redirect.success) return { kind: 'redirect', url: redirect.data.signed_url };
  throw new Error('The server sent the file in a form this page cannot read. Try again.');
}

/**
 * Save a document to the device. Every download comes through here, and the saved name
 * always carries the extension of the STORED type (savedFileName), never the uploader's:
 * the bytes were checked against the type, not the name. A plaintext document's signed
 * link is fetched here rather than opened, so it too is saved under that name.
 */
export async function downloadDocument(doc: DocumentRef): Promise<void> {
  const got = await fetchDocument(doc, 'download');
  let blob: Blob;
  if (got.kind === 'bytes') {
    blob = got.blob;
  } else {
    const res = await fetch(got.url);
    // An expired link answers 403 with an error page; never save that as the document.
    if (!res.ok) throw new Error('The download failed. Try again.');
    blob = new Blob([await res.arrayBuffer()], { type: doc.mimeType });
  }
  downloadBlob(blob, savedFileName(doc.filename, doc.mimeType));
}

export interface PreviewSource {
  url: string;
  mimeType: string;
  filename: string;
  /**
   * The bytes, when they came back in the answer. Renderers read THIS, never fetch the
   * `blob:` url: a page's CSP usually allows blob: for images and frames but not for
   * connect-src, so fetching it fails in production only.
   */
  blob?: Blob;
}

/** What the viewer shows: an object URL over the bytes, or the signed link. Revoke `url` when done. */
export async function previewDocument(doc: DocumentRef): Promise<PreviewSource> {
  const got = await fetchDocument(doc, 'preview');
  if (got.kind === 'redirect') return { url: got.url, mimeType: doc.mimeType, filename: doc.filename };
  return { url: URL.createObjectURL(got.blob), mimeType: doc.mimeType, filename: doc.filename, blob: got.blob };
}

/** The raw bytes (pdf.js and pdf-lib take a typed array). */
export async function documentBytes(doc: DocumentRef): Promise<Uint8Array> {
  const got = await fetchDocument(doc, 'preview');
  if (got.kind === 'bytes') return new Uint8Array(await got.blob.arrayBuffer());
  const res = await fetch(got.url);
  // A signed link that expired answers 403 with an error page, not a network failure.
  if (!res.ok) throw new Error('The preview could not be loaded.');
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Annotations (the owner's alone; never realtime)
// ---------------------------------------------------------------------------

interface AnnotationRow {
  id: string;
  document_id: string;
  page_index: number;
  kind: string;
  data: unknown;
  created_at: string;
  updated_at: string;
}

/** A document's annotations in the order they were made. Malformed rows are skipped, counted, never shown. */
export async function listAnnotations(documentId: string): Promise<DocumentAnnotation[]> {
  const rows = await readAll<AnnotationRow>('document_annotations', 'id, document_id, page_index, kind, data, created_at, updated_at', (q) =>
    q.eq('document_id', documentId));
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : tieId(a, b)));
  const valid: DocumentAnnotation[] = [];
  let skipped = 0;
  for (const row of rows) {
    const kind = row.kind as AnnotationKind;
    if (isAnnotationData(kind, row.data)) valid.push({ ...row, kind, data: row.data } as DocumentAnnotation);
    else skipped += 1;
  }
  // The count only: an annotation's content can quote the document.
  if (skipped > 0) console.error(`Skipped ${skipped} malformed annotation row(s)`);
  return valid;
}

/** Save one annotation (insert or replace). Validated here as on read, so nothing malformed is stored. */
export async function saveAnnotation(row: Pick<DocumentAnnotation, 'id' | 'document_id' | 'page_index' | 'kind' | 'data'>): Promise<void> {
  if (!isAnnotationData(row.kind, row.data)) throw new Error('The annotation could not be saved.');
  const { error } = await getSupabase()
    .from('document_annotations')
    .upsert({ id: row.id, document_id: row.document_id, page_index: row.page_index, kind: row.kind, data: row.data }, { onConflict: 'id' });
  if (error) throw new Error('The annotation could not be saved.');
}

export async function deleteAnnotation(id: string): Promise<void> {
  const { error } = await getSupabase().from('document_annotations').delete().eq('id', id);
  if (error) throw new Error('The annotation could not be deleted.');
}
