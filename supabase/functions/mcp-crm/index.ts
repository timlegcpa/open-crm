import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createMcpCrmHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const { service } = supabaseClients(createClient, config);
const org = createOrgLoader({ db: service, supabaseUrl: config.supabaseUrl });

Deno.serve(
  createMcpCrmHandler({
    allowedOrigins: config.allowedOrigins,
    supabaseUrl: config.supabaseUrl,
    siteUrl: config.siteUrl,
    db: service,
    orgName: async () => (await org.load()).displayName,
  }),
);
