import { childPath } from './lib/folderPath';

/**
 * The two sections of a contact's file store: `held_by` on every row.
 *   owner   what the owner shares with the contact ("Shared documents")
 *   client  what the contact uploaded ("Uploaded documents")
 */
export const SECTIONS = ['owner', 'client'] as const;
export type Section = (typeof SECTIONS)[number];

export function isSection(value: unknown): value is Section {
  return value === 'owner' || value === 'client';
}

/** A row of client_documents, as the browser reads it. */
export interface ClientDocument {
  id: string;
  contact_id: string;
  uploaded_by: string | null;
  filename: string;
  original_filename: string;
  storage_path: string;
  file_size: number;
  mime_type: string;
  category: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  folder_path: string;
  held_by: Section;
  reviewed_at: string | null;
  reviewed_by: string | null;
  encryption_iv: string | null;
  encryption_status: 'none' | 'encrypted';
  /**
   * The one other contact who may read this document. Set per document by the owner,
   * never inferred from a relationship; read-only to that contact.
   */
  shared_with_contact_id: string | null;
}

/** A row of client_folders. Its full path is parent_path + name + '/'. */
export interface ClientFolder {
  id: string;
  contact_id: string;
  parent_path: string;
  name: string;
  created_at: string;
  held_by: Section;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

/** The fewest folder fields the path pickers need. */
export interface FolderPathRow {
  id: string;
  name: string;
  parent_path: string;
}

/** A folder's full path ('/a/b/'). */
export function fullPathOf(f: FolderPathRow): string {
  return childPath(f.parent_path, f.name);
}

/** What a preview or download needs to know about a document: the row decides the name and type. */
export interface DocumentRef {
  id: string;
  filename: string;
  mimeType: string;
}

export function refOf(doc: Pick<ClientDocument, 'id' | 'original_filename' | 'mime_type'>): DocumentRef {
  return { id: doc.id, filename: doc.original_filename, mimeType: doc.mime_type };
}

/** A contact as the documents index and the share picker show it. */
export interface DocumentContact {
  id: string;
  full_name: string;
  business_name: string | null;
  email: string | null;
  status: string;
}
