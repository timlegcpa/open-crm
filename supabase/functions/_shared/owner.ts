// The owner's sign-in address, read from Auth through the service client: org_profile names
// the owner's user id (0001_core.sql), and Auth holds the current address, so a notice
// always follows the owner's address as it is now, not as it was when something was set up.
// Used by lead-intake (the new-lead notice) and mfa-recovery (the owner's copy of a
// recovery alert).

/** The slice of a Supabase service client this module calls. supabase-js clients satisfy it. */
export interface OwnerClient {
  from(table: string): {
    select(columns: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{ data: { user: { email?: string | null } | null }; error: unknown }>;
    };
  };
}

/** The owner's user id from org_profile, or null before an owner exists. A failed read throws. */
export async function loadOwnerUserId(service: OwnerClient): Promise<string | null> {
  const { data, error } = await service.from('org_profile').select('owner_user_id').maybeSingle();
  if (error) throw error;
  const id = (data as { owner_user_id?: unknown } | null)?.owner_user_id;
  return typeof id === 'string' ? id : null;
}

/** The owner's current sign-in address, or null when there is no owner or no address. A failed read throws. */
export async function loadOwnerEmail(service: OwnerClient): Promise<string | null> {
  const id = await loadOwnerUserId(service);
  if (!id) return null;
  const { data, error } = await service.auth.admin.getUserById(id);
  if (error) throw error;
  return data.user?.email ?? null;
}
