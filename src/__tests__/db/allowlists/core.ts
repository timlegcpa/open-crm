import type { DomainAllowlist } from './types';

/** 0001_core. */
export const allowlist: DomainAllowlist = {
  anonCallable: ['get_org_branding()'],
  authenticatedCallable: [
    'is_owner()', 'mfa_session_ok()', 'user_has_verified_mfa()', 'audit_actor()', 'is_owner_or_server()',
    'org_profile_guard_principals()', 'set_updated_at()', 'retry_job(uuid)', 'get_job_status_counts()',
    'get_org_branding()',
  ],
  // What the job-runner, csp-report and the shared rate limiter call as the server.
  serverRpcs: [
    'claim_next_jobs(integer,integer)', 'complete_job(uuid,uuid,jsonb)', 'fail_job(uuid,uuid,text)',
    'cleanup_core_operational_rows()', 'cleanup_aged_audit_logs()',
    'check_auth_ip_rate_limit(text,text,integer,integer,text)', 'check_auth_global_rate_limit(text,integer,integer)',
    'check_auth_user_rate_limit(text,uuid,integer,integer)',
    'check_public_rate_limit(text,text,integer,integer,integer,integer,text)',
  ],
  impersonationExempt: {
    'audit_logs.audit_logs_owner_insert':
      'is_owner() gates the insert; auth.uid() only pins user_id to the writer, and a View-as-client session is a client session, which never passes is_owner()',
  },
  definerWriteExempt: {
    'retry_job(uuid)': 'owner only: a View-as-client session is a client session, which never passes is_owner()',
  },
};
