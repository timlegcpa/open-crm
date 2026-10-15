import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { PORTAL_USER_BAN_DURATION } from '../_shared/portal-account.ts';
import { createRevokeHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createRevokeHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async accountContact(accountId) {
      const { data, error } = await server.from('client_portal_accounts').select('contact_id').eq('id', accountId).maybeSingle();
      if (error) throw error;
      return (data as { contact_id: string } | null)?.contact_id ?? null;
    },

    async deactivate(accountId) {
      const { data, error } = await server.rpc('deactivate_portal_account', { p_account_id: accountId });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async banUser(userId) {
      const { error } = await server.auth.admin.updateUserById(userId, { ban_duration: PORTAL_USER_BAN_DURATION });
      // A user already gone cannot sign in either.
      if (error && error.status !== 404) throw error;
    },

    async audit({ ownerId, action, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action, details, ip, userAgent });
    },
  }),
);
