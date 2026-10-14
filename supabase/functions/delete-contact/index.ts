import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createDeleteContactHandler, type BeginResult } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createDeleteContactHandler({
    allowedOrigins: config.allowedOrigins,

    // The database decides, with the caller's own token: is_owner() checks the owner row
    // and the MFA level in the same claims PostgREST sees.
    authorizeOwner: (token) => authorizeOwner(clients, token),

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
      await auditLog.write({
        actorId: ownerId,
        action: 'contact_deleted',
        details: {
          contact_id: contactId,
          portal_users_removed: portalUsersRemoved,
          ...(orphanedUserIds.length > 0 ? { orphaned_sign_ins: orphanedUserIds } : {}),
        },
      });
    },
  }),
);
