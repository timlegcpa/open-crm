// The connector's opaque secrets: how they are minted, how they are stored, and the exact
// shapes each endpoint accepts. Shared by mcp-oauth (which mints) and mcp-crm (which
// checks an access token's shape before any database work). Pure WebCrypto, so vitest and
// Deno run it alike.
//
// Every secret is 32 random bytes in base64url (43 characters, randomTokenBase64Url) and is
// stored only as its SHA-256 hex digest (sha256Hex), both from _shared/crypto.ts: a
// database read leaks no usable code or token.

/** OAuth scope: the one this server grants. */
export const SCOPE = 'mcp:crm';

export const ACCESS_TOKEN_PREFIX = 'mcpat_';
export const REFRESH_TOKEN_PREFIX = 'mcprt_';
export const CLIENT_ID_PREFIX = 'mcpc_';

/** An access token exactly as minted: the prefix and 43 base64url characters. */
export const ACCESS_TOKEN_RE = /^mcpat_[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43 to 128 unreserved characters. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is base64url without padding. */
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
export const CLIENT_ID_RE = /^mcpc_[A-Za-z0-9_-]{20,80}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256: base64url(SHA-256(ascii(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** The MCP server's URL, which every token is bound to (RFC 8707 resource). */
export function mcpResourceUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp-crm`;
}

/** Where the MCP server publishes its RFC 9728 protected-resource metadata. */
export function protectedResourceMetadataUrl(supabaseUrl: string): string {
  return `${mcpResourceUrl(supabaseUrl)}/.well-known/oauth-protected-resource`;
}

/** The subpath after `/<fn>` in a request URL: '' for the function's root, else e.g. 'token'. */
export function endpointOf(url: string, fn: string): string | null {
  const path = new URL(url).pathname;
  const at = path.indexOf(`/${fn}`);
  if (at < 0) return null;
  const rest = path.slice(at + fn.length + 1);
  if (rest !== '' && !rest.startsWith('/')) return null;
  return rest.replace(/^\/+|\/+$/g, '');
}
