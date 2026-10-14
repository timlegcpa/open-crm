/**
 * What one domain's migration grants beyond the schema-wide rules, stated where the
 * domain's builder can add it without editing a shared file. Each domain keeps one file
 * here (core.ts for 0001, contacts.ts for 0002, documents.ts for 0003, ...); index.ts
 * gathers every file it finds. Function signatures are written without the schema,
 * exactly as regprocedure prints them in public: 'retry_job(uuid)'.
 */
export interface DomainAllowlist {
  /** Functions anon may execute: display fields for pages shown before sign-in. */
  anonCallable?: string[];
  /** Functions a signed-in session may execute. Any other function is the server's alone (or a trigger's). */
  authenticatedCallable?: string[];
  /** Functions the server calls by RPC. */
  serverRpcs?: string[];
  /**
   * Write policies that look client-writable to the View-as-client invariant but are not,
   * by `table.policy`, each with its reason. An entry excuses only a reference to
   * get_client_contact_id() or auth.uid(): the policy must still require is_owner() at
   * its top level, or it is reported anyway.
   */
  impersonationExempt?: Record<string, string>;
  /**
   * SECURITY DEFINER functions a signed-in session may call that write a table without
   * trg_impersonation_read_only, each with its reason. An entry must open with the owner
   * refusal (IF NOT public.is_owner() THEN RAISE) before any write.
   */
  definerWriteExempt?: Record<string, string>;
}
