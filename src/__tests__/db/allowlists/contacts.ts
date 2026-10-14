import type { DomainAllowlist } from './types';

/** 0002_contacts. */
export const allowlist: DomainAllowlist = {
  authenticatedCallable: [
    'get_client_contact_id()', 'is_view_as_client()', 'get_my_contact()', 'get_my_activity(integer)',
    'contact_emails_set_default(uuid,uuid,text)',
  ],
  serverRpcs: [
    'get_client_contact_id()', 'increment_invitation_attempt(uuid,integer)', 'contact_delete_claim_live(uuid)',
    'admin_contact_delete_begin(uuid)', 'admin_contact_delete_release(uuid,jsonb,uuid,uuid[])',
    'admin_delete_contact(uuid,uuid)', 'is_impersonation_session(uuid,uuid)',
    'revoke_impersonation_auth_session(uuid)', 'auto_end_stale_impersonation_sessions()',
  ],
};
