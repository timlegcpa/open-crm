import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../_shared/config.ts';
import { createDeleteContactHandler, type BeginResult } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(
  createDeleteContactHandler({
    allowedOrigins: config.allowedOrigins,

    async authorizeOwner(token) {
      const { data, error } = await server.auth.getUser(token);
      if (error || !data.user) return null;
      // The database decides, with the caller's own token: is_owner() checks the owner
      // row and the MFA level in the same claims PostgREST sees.
      const asCaller = createClient(config.supabaseUrl, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: isOwner, error: ownerErr } = await asCaller.rpc('is_owner');
      if (ownerErr) throw ownerErr;
      return isOwner === true ? data.user.id : null;
    },

    async begin(contactId) {
      const { data, error } = await server.rpc('admin_contact_delete_begin', { p_contact_id: contactId });
      if (error) throw error;
      // RETURNS TABLE: always one row, with user_ids and prior initialised before any branch.
      const [row] = data as BeginResult[];
      return row;
    },

    async deleteAuthUser(userId) {
      const { error } = await server.auth.admin.deleteUser(userId);
      if (!error) return 'deleted';
      if (error.status === 404) return 'missing';
      throw error;
    },

    async finish(contactId, claim) {
      const { data, error } = await server.rpc('admin_delete_contact', { p_contact_id: contactId, p_claim: claim });
      if (error) throw error;
      return (data as string[] | null) ?? [];
    },

    async release(contactId, prior, claim, destroyed) {
      const { error } = await server.rpc('admin_contact_delete_release', {
        p_contact_id: contactId,
        p_prior: prior,
        p_claim: claim,
        p_destroyed: destroyed,
      });
      if (error) throw error;
    },

    async audit(ownerId, contactId, portalUsersRemoved, orphanedUserIds) {
      const { error } = await server.from('audit_logs').insert({
        user_id: ownerId,
        action: 'contact_deleted',
        details: {
          contact_id: contactId,
          portal_users_removed: portalUsersRemoved,
          ...(orphanedUserIds.length > 0 ? { orphaned_sign_ins: orphanedUserIds } : {}),
        },
      });
      if (error) throw error;
    },

    log(message, detail) {
      console.error(`[delete-contact] ${message}`, detail);
    },
  }),
);
