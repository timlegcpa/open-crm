import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import { createLeadIntakeKeyHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createLeadIntakeKeyHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    userLimit: (userId) => checkUserLimit(server, { action: 'lead_intake_key', userId, max: 10, windowMinutes: 60 }),

    async saveKey(row) {
      const { error } = await server
        .from('lead_intake_keys')
        .upsert({ id: true, ...row, created_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
    },

    async deleteKey() {
      const { error } = await server.from('lead_intake_keys').delete().eq('id', true);
      if (error) throw error;
    },

    audit: (ownerId, action) => auditLog.write({ actorId: ownerId, action }),
  }),
);
