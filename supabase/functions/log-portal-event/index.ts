import { createClient } from '@supabase/supabase-js';
import { authorizeClient, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import { createLogPortalEventHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;

Deno.serve(
  createLogPortalEventHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeClient: (token) => authorizeClient(clients, token),
    rateLimit: ({ principal }) =>
      checkUserLimit(server, { action: 'log_portal_event', userId: principal.userId, max: 500, windowMinutes: 60 }),

    async insertEvent({ contactId, userId, action, ip, userAgent }) {
      const { error } = await server.from('client_activity_log').insert({
        contact_id: contactId,
        user_id: userId,
        action,
        // The server writes as the service role, which the client stamp trigger exempts,
        // so the actor is stated here: never taken from the caller.
        details: { actor_role: 'client' },
        ip_address: ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null,
      });
      if (error) throw error;
    },

    async recordLogin(userId) {
      const { error } = await server.rpc('record_portal_login', { p_user: userId });
      if (error) throw error;
    },
  }),
);
