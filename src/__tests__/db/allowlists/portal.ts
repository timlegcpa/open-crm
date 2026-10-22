import type { DomainAllowlist } from './types';

/** 0012_portal and 0017_crm_full_access: the invite and sign-in functions, the server's alone. */
export const allowlist: DomainAllowlist = {
  serverRpcs: [
    'portal_invite_throttled(uuid)',
    'create_portal_invitation(uuid,text,text,timestamp with time zone,uuid)',
    'reissue_portal_invitation(uuid,text,timestamp with time zone,uuid)',
    'link_portal_invitation(uuid,uuid)',
    'deactivate_portal_account(uuid)',
    'record_portal_login(uuid)',
    'find_auth_user_id_by_email(text)',
    'claim_portal_invitation(uuid,uuid)',
    'release_portal_invitation_claim(uuid,uuid)',
    'delete_stale_portal_user(uuid,uuid,uuid)',
    'impersonation_credential_changes(uuid)',
    // 0017: the database half of changing a sign-in address (change-portal-email, mcp-crm).
    'portal_login_for_change(uuid,text,text)',
    'portal_set_login_email(uuid,text,text)',
  ],
};
