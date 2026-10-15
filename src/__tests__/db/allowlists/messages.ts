import type { DomainAllowlist } from './types';

/** 0004_messages. */
export const allowlist: DomainAllowlist = {
  authenticatedCallable: ['get_org_public_key()', 'admin_list_conversations()'],
  serverRpcs: ['cleanup_read_client_messages()'],
  impersonationExempt: {
    'organization_keys.organization_keys_owner_insert':
      'is_owner() gates the insert; auth.uid() only pins owner_user_id to the writer, and a View-as-client session is never the owner',
    'organization_keys.organization_keys_owner_update':
      'is_owner() gates the update; auth.uid() only keeps the owner on its own key row, and a View-as-client session is never the owner',
  },
};
