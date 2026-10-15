import type { DomainAllowlist } from './types';

/**
 * 0005_requests. A signed-in session calls one function here: the owner's builder save,
 * which refuses anyone but the owner first. Every other owner write goes through RLS, and
 * every client write goes through the needs-save edge function, which calls these as the
 * server. The other draft functions are the server's (the AI connector reaches them through it).
 */
const OWNER_ONLY =
  'owner only: it refuses anyone but the owner before it writes, and a View-as-client session is a client session, which never passes is_owner()';

export const allowlist: DomainAllowlist = {
  authenticatedCallable: ['needs_owner_save_draft(uuid,uuid,integer,text,text,boolean,jsonb)'],
  definerWriteExempt: {
    'needs_owner_save_draft(uuid,uuid,integer,text,text,boolean,jsonb)': OWNER_ONLY,
  },
  serverRpcs: [
    'needs_list_progress(uuid[])',
    'needs_replace_draft(uuid,text,jsonb,text,uuid,boolean)',
    'needs_delete_draft(uuid,uuid,integer,uuid,inet,text)',
    'needs_send_list(uuid,integer)',
    'needs_record_reminder(uuid)',
    'needs_issue_start_link(uuid,text,text,timestamp with time zone,uuid,boolean)',
    'needs_client_set_answer(uuid,uuid,text,bytea)',
    'needs_client_mark_todo(uuid,uuid,boolean)',
    'needs_client_link_document(uuid,uuid,uuid)',
    'needs_client_submit(uuid,uuid)',
    'needs_claim_upload_notice(uuid)',
    'needs_release_upload_notice(uuid,timestamp with time zone)',
    'start_link_access_revoked(uuid,text)',
    'start_link_lookup(text)',
    'expire_start_link(uuid)',
    'claim_start_link(uuid,uuid)',
    'release_start_link_claim(uuid,uuid)',
    'delete_stale_start_link_user(uuid,uuid,uuid)',
    'link_start_link(uuid,uuid,uuid)',
    'retire_start_link(uuid)',
    'cleanup_stale_start_links()',
  ],
};
