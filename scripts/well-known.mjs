// Writes the AI connector's discovery document into the built site:
// dist/.well-known/oauth-authorization-server, from VITE_SITE_URL and VITE_SUPABASE_URL.
//
// An MCP client finds the authorization server at <issuer>/.well-known/oauth-authorization-server
// (RFC 8414), and the issuer is the site (SITE_URL), not the Supabase project. So the static
// host that serves the app must also serve this one JSON file, with
// `Content-Type: application/json` (it has no extension, so the host may need a rule for it).
// The document is the same one mcp-oauth answers at its own /.well-known path;
// src/__tests__/wellKnown.test.ts holds this copy equal to authorizationServerMetadata() for
// the same inputs. It is a copy because Vite's config runs in Node, which cannot load the
// function's TypeScript.
//
// With either variable unset, nothing is written and the build says so: the CRM works
// without the connector, and a document naming the wrong issuer would be worse than none.

export const WELL_KNOWN_PATH = '.well-known/oauth-authorization-server';
const SCOPE = 'mcp:crm';

/** An http(s) URL's origin, or null: the same reading the edge functions give SITE_URL. */
export function originOf(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The RFC 8414 document for a site and a Supabase project, or null when either is missing. */
export function authorizationServerDocument(siteUrl, supabaseUrl) {
  const issuer = siteUrl ? originOf(siteUrl) : null;
  const project = supabaseUrl ? originOf(supabaseUrl) : null;
  if (!issuer || !project) return null;
  const base = `${String(supabaseUrl).trim().replace(/\/+$/, '')}/functions/v1/mcp-oauth`;
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

/** The Vite plugin: emits the document on build and serves it in dev. */
export function wellKnownMetadata() {
  let doc = null;
  return {
    name: 'open-crm:well-known',
    configResolved(config) {
      doc = authorizationServerDocument(config.env.VITE_SITE_URL, config.env.VITE_SUPABASE_URL);
      if (!doc && config.command === 'build') {
        config.logger.info(`[well-known] VITE_SITE_URL or VITE_SUPABASE_URL is not set: ${WELL_KNOWN_PATH} is not written (needed only for the AI connector).`);
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!doc || (req.url ?? '').split('?')[0] !== `/${WELL_KNOWN_PATH}`) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(doc));
      });
    },
    generateBundle() {
      if (doc) this.emitFile({ type: 'asset', fileName: WELL_KNOWN_PATH, source: `${JSON.stringify(doc, null, 2)}\n` });
    },
  };
}
