import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createChangePortalEmailHandler, type CheckOutcome, type SetOutcome } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createChangePortalEmailHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async check(accountId, email, expected) {
      const { data, error } = await server.rpc('portal_login_for_change', { p_account_id: accountId, p_email: email, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: CheckOutcome; user_id?: string; contact_id?: string };
    },

    async setSignInEmail(userId, email) {
      const { error } = await server.auth.admin.updateUserById(userId, { email, email_confirm: true });
      if (!error) return 'changed';
      // A 4xx is Auth refusing (an address in use, a malformed one): nothing moved.
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return 'refused';
      throw error;
    },

    async setRecord(accountId, email, expected) {
      const { data, error } = await server.rpc('portal_set_login_email', { p_account_id: accountId, p_email: email, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: SetOutcome; contact_id?: string; contact_address?: string };
    },

    async audit({ ownerId, action, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action, details, ip, userAgent });
    },
  }),
);
