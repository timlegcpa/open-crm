import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { createSendNeedsListHandler } from './handler.ts';
import { createNeedsSendStore } from './store.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const auditLog = createAudit({ db: server });

Deno.serve(
  createSendNeedsListHandler({
    ...createNeedsSendStore({ server, org, outbound }),
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    audit: (entry) => auditLog.write(entry),
  }),
);
