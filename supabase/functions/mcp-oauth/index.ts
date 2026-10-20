import { createClient } from '@supabase/supabase-js';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createLogger } from '../_shared/log.ts';
import { createMcpOauthHandler, jwtAal, parseExtraRedirectUris } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
// The adopter's extra assistant callbacks. A refused entry widens nothing; it is named
// (scheme, host and path) once at start so the mistake is visible in the function's log.
const extra = parseExtraRedirectUris(Deno.env.get('MCP_EXTRA_REDIRECT_URIS'));
if (extra.rejected.length > 0) {
  createLogger('mcp-oauth').warn(
    `MCP_EXTRA_REDIRECT_URIS entries ignored (each must be an exact https address with no query or fragment): ${JSON.stringify(extra.rejected)}`,
  );
}

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
    extraRedirectUris: extra.uris,
  }),
);
