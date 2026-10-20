import type { DomainAllowlist } from './types';

/** 0007_mcp and 0015_mcp. */
export const allowlist: DomainAllowlist = {
  // The owner's view of connected assistants, in Settings. Each refuses anyone but the owner.
  authenticatedCallable: ['mcp_list_grants()', 'mcp_revoke_grant(uuid)'],
  serverRpcs: [
    'mcp_audit_row(uuid,text,jsonb,text,text)',
    'mcp_oauth_client(text)',
    'mcp_oauth_pending_request(text)',
    'mcp_oauth_decide(text,boolean,text,timestamp with time zone,integer,uuid,text,text)',
    'mcp_oauth_consume_code(text)',
    'mcp_oauth_create_grant(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,uuid,timestamp with time zone,integer,text,text)',
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
    // The request tools (wave 6b).
    'mcp_request_snapshot(uuid,uuid,integer)',
    'mcp_list_requests(uuid,integer,uuid,text,text)',
    'mcp_request_keys_active(jsonb)',
    'mcp_request_audit(uuid,text,jsonb,text,text)',
    'mcp_create_request(uuid,text,text,jsonb,uuid,text,text)',
    'mcp_update_request(uuid,uuid,integer,text,text,jsonb,uuid,text,text)',
    'mcp_delete_request(uuid,uuid,integer,uuid,text,text)',
    'mcp_claim_reminder(uuid,uuid)',
    'mcp_release_reminder(uuid,timestamp with time zone,timestamp with time zone)',
    // 0015_mcp: the pipeline, the work board and the request follow-up.
    'mcp_consent_version()',
    'mcp_set_contact_status(uuid,text,text,uuid,text,text)',
    'mcp_list_board(text,uuid,integer,uuid,text,text)',
    'mcp_work_item_contact_ok(uuid,text)',
    'mcp_create_work_item(text,uuid,text,text,text,date,uuid,text,text)',
    'mcp_update_work_item(uuid,jsonb,uuid,text,text)',
    'mcp_move_work_item(uuid,text,text,text,uuid,text,text)',
    'mcp_add_work_item_note(uuid,text,uuid,text,text)',
    'mcp_close_request(uuid,uuid,uuid,text,text)',
    'mcp_accept_request(uuid,uuid,uuid,text,text)',
    'mcp_set_request_reminders(uuid,uuid,boolean,uuid,text,text)',
    'mcp_list_open_requests(integer,uuid,text,text)',
  ],
  definerWriteExempt: {
    'mcp_revoke_grant(uuid)':
      'owner only: it refuses anyone but the owner before it writes, and a View-as-client session is a client session, which never passes is_owner()',
  },
};
