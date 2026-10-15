import type { DomainAllowlist } from './types';

/** 0007_mcp. */
export const allowlist: DomainAllowlist = {
  // The owner's view of connected assistants, in Settings. Each refuses anyone but the owner.
  authenticatedCallable: ['mcp_list_grants()', 'mcp_revoke_grant(uuid)'],
  serverRpcs: [
    'mcp_audit_row(uuid,text,jsonb,text,text)',
    'mcp_oauth_client(text)',
    'mcp_oauth_pending_request(text)',
    'mcp_oauth_decide(text,boolean,text,timestamp with time zone,uuid,text,text)',
    'mcp_oauth_consume_code(text)',
    'mcp_oauth_create_grant(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,uuid,timestamp with time zone,text,text)',
    'mcp_oauth_rotate_refresh(text,text,text,timestamp with time zone,text,timestamp with time zone,text,text)',
    'mcp_oauth_revoke_token(text,text,text)',
    'mcp_oauth_authenticate(text)',
    'mcp_oauth_cleanup()',
    'mcp_tool_vocabulary()',
    'mcp_search_contacts(text,text,integer,uuid,text,text)',
    'mcp_get_contact(uuid,uuid,text,text)',
    'mcp_create_contact(jsonb,uuid,text,text)',
    'mcp_update_contact(uuid,jsonb,uuid,text,text)',
    'mcp_correct_contact_email(uuid,text,text,uuid,text,text)',
    'mcp_add_business(uuid,text,text,uuid,text,text)',
    'mcp_log_call_note(uuid,text,text,uuid,text,text)',
    'mcp_upsert_quote(uuid,uuid,text,text,numeric,uuid,text,text)',
    'mcp_delete_quote(uuid,uuid,uuid,text,uuid,text,text)',
  ],
  definerWriteExempt: {
    'mcp_revoke_grant(uuid)':
      'owner only: it refuses anyone but the owner before it writes, and a View-as-client session is a client session, which never passes is_owner()',
  },
};
