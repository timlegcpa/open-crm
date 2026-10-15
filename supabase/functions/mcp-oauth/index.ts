import { createClient } from '@supabase/supabase-js';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createMcpOauthHandler, jwtAal } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);

Deno.serve(
  createMcpOauthHandler({
    allowedOrigins: config.allowedOrigins,
    supabaseUrl: config.supabaseUrl,
    siteUrl: config.siteUrl,
    // The database decides who the owner is, with the caller's own token; the aal check
    // then reads the same token Auth just verified.
    authorizeOwner: (token) => authorizeOwner(clients, token),
    sessionAal: jwtAal,
    db: clients.service,
  }),
);
