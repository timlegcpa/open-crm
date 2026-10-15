import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createOrgLogoHandler, LOGO_BUCKET } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createOrgLogoHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async upload(path, bytes, contentType) {
      const { error } = await server.storage.from(LOGO_BUCKET).upload(path, bytes, { contentType, upsert: false });
      if (error) throw error;
    },

    async setLogoPath(logoPath) {
      const { error } = await server.from('org_profile').update({ logo_path: logoPath }).eq('id', true);
      if (error) throw error;
    },

    audit: (ownerId) => auditLog.write({ actorId: ownerId, action: 'org_logo_updated' }),
  }),
);
