import type { ExplorerContact } from './types';

/**
 * Contacts shown in the owner's documents index: every active client, PLUS any
 * contact (whatever their status: one_time, lost, and so on) that still holds at
 * least one document or folder.
 *
 * Without the second clause the roster filtered on `status === 'client'` alone,
 * so moving a client to a non-client status silently hid their existing files.
 */
export function selectDocumentTreeContacts(
  contacts: ExplorerContact[],
  contactIdsWithDocuments: Iterable<string>,
): ExplorerContact[] {
  const withDocs = new Set(contactIdsWithDocuments);
  return contacts.filter((c) => c.status === 'client' || withDocs.has(c.id));
}
