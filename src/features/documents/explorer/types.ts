import type { ContactListRow } from '@/api/contacts';

export type { ClientDocument, ClientFolder, FolderPathRow } from '../types';
export { fullPathOf } from '../types';

/**
 * A contact as the explorer's index lists it and searches it. Any contact row
 * (ContactListRow, Contact) satisfies it, so the contact tab can lock the explorer to
 * the record it already holds.
 */
export type ExplorerContact = Pick<ContactListRow, 'id' | 'full_name' | 'business_name' | 'email' | 'phone' | 'status'>;
