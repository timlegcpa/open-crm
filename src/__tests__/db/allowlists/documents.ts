import type { DomainAllowlist } from './types';

/** 0003_documents. Every RPC runs as the caller (SECURITY INVOKER), so RLS decides; the owner-only ones refuse inside. */
export const allowlist: DomainAllowlist = {
  authenticatedCallable: [
    'client_document_rename(uuid,text)',
    'client_document_move(uuid,text)',
    'rename_client_folder(uuid,text)',
    'move_client_folder(uuid,text)',
    'admin_client_folder_remove(uuid)',
    'portal_folder_purge(uuid)',
    'mark_client_folder_reviewed(uuid)',
    'get_contact_ids_with_documents()',
  ],
};
