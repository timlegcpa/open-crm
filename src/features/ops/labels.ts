import type { JobKind } from '../../../supabase/functions/job-runner/kinds';

/**
 * What the System pages call things. The job kinds are the job-runner's own list (a type
 * import, so nothing from the functions folder is bundled; a test pins the keys to it).
 */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  'esign:expire_envelopes': 'Expire e-signature envelopes',
  'needs:reminder_dispatch': 'Request reminders',
  'portal:daily_digest': 'Portal daily digest',
  'ops:maintenance': 'Clean up old records',
};

export function jobKindLabel(provider: string, action: string): string {
  const kind = `${provider}:${action}`;
  return Object.hasOwn(JOB_KIND_LABELS, kind) ? JOB_KIND_LABELS[kind as JobKind] : kind;
}

/** Audit actions written by the database and the shared server paths; anything else is humanised. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  owner_login: 'Signed in',
  owner_logout: 'Signed out',
  mfa_enabled: 'Two-step sign-in turned on',
  mfa_disabled: 'Two-step sign-in turned off',
  mfa_backup_codes_generated: 'Backup codes generated',
  mfa_backup_codes_revoked: 'Backup codes revoked',
  mfa_recovery_used: 'Backup code used to sign in',
  contact_deleted: 'Contact deleted',
  // Settings
  settings_update: 'Settings changed',
  password_change: 'Password changed',
  email_change_requested: 'Email change requested',
  sign_out_all_devices: 'Signed out everywhere',
  lead_intake_key_rotated: 'Lead intake key replaced',
  lead_intake_key_revoked: 'Lead intake key removed',
  org_logo_updated: 'Logo changed',
  // Documents
  document_delete: 'Document deleted',
  folder_delete: 'Folder deleted',
  folder_bulk_delete: 'Folders deleted',
  // Requests
  needs_list_sent: 'Request sent',
  needs_list_reminded: 'Request reminder sent',
  needs_list_deleted: 'Request deleted',
  needs_list_files_deleted: "Deleted request's files removed",
  'needs.reveal_answer': 'Sensitive answer revealed',
  // E-signature
  esign_envelope_deleted: 'Envelope deleted',
  // Portal and View as client
  portal_invite_sent: 'Portal invitation sent',
  portal_invite_resent: 'Portal invitation sent again',
  portal_access_deactivated: 'Portal access turned off',
  impersonate_start: 'View as client started',
  impersonate_end: 'View as client ended',
  // Group email
  group_email_sent: 'Group email sent',
  // Messages (written by the key table's trigger)
  messages_key_created: 'Messages encryption set up',
  messages_key_rewrapped: 'Messages password or recovery key changed',
  // The AI connector: its approvals, and what the agent did through it
  mcp_oauth_approved: 'AI connector approved',
  mcp_oauth_denied: 'AI connector refused',
  mcp_oauth_grant_created: 'AI connector connected',
  mcp_oauth_refreshed: 'AI connector session renewed',
  mcp_oauth_revoked: 'AI connector disconnected',
  mcp_oauth_replay_revoked: 'AI connector disconnected after a reused token',
  mcp_oauth_code_rejected: 'AI connector sign-in code refused',
  mcp_search_contacts: 'Agent searched contacts',
  mcp_get_contact: 'Agent opened a contact',
  mcp_create_contact: 'Agent created a contact',
  mcp_update_contact: 'Agent updated a contact',
  mcp_correct_contact_email: "Agent corrected a contact's email",
  mcp_add_business: 'Agent added a business',
  mcp_log_call_note: 'Agent logged a call note',
  mcp_upsert_quote: 'Agent saved a quote',
  mcp_delete_quote: 'Agent deleted a quote',
  mcp_create_request: 'Agent drafted a request',
  mcp_update_request: 'Agent rewrote a draft request',
  mcp_list_requests: "Agent read a contact's requests",
  mcp_send_request: 'Agent sent a request',
  mcp_remind_request: 'Agent sent a request reminder',
  mcp_delete_request: 'Agent deleted a draft request',
  mcp_set_contact_status: "Agent moved a contact's stage",
  mcp_list_board: 'Agent read the board',
  mcp_create_work_item: 'Agent added a card',
  mcp_update_work_item: 'Agent edited a card',
  mcp_move_work_item: 'Agent moved a card',
  mcp_add_work_item_note: 'Agent noted a card',
  mcp_close_request: 'Agent closed a request',
  mcp_accept_request: "Agent accepted a request's answers",
  mcp_set_request_reminders: "Agent paused or resumed a request's reminders",
  mcp_list_open_requests: 'Agent read the open requests',
};

/** The portal's activity actions (0002_contacts.sql), every one. */
export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  session_start: 'Session started',
  session_expired: 'Session expired',
  invitation_accepted: 'Invitation accepted',
  start_link_consumed: 'Start link used',
  profile_update: 'Profile updated',
  password_change: 'Password changed',
  password_reset_sent: 'Password reset sent',
  document_upload: 'Document uploaded',
  document_download: 'Document downloaded',
  document_delete: 'Document deleted',
  message_sent: 'Message sent',
  message_read: 'Message read',
  esign_signed: 'Document signed',
  email_sent: 'Email sent',
  account_suspended: 'Portal access suspended',
  account_reactivated: 'Portal access restored',
  account_deleted: 'Portal access removed',
};

/** 'contact_deleted' or 'contact.updated' as 'Contact deleted', 'Contact updated'. */
export function humanize(key: string): string {
  const words = key.replace(/[._]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export function actionLabel(labels: Record<string, string>, action: string): string {
  return Object.hasOwn(labels, action) ? labels[action] : humanize(action);
}
