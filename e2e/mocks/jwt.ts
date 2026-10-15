/**
 * Access tokens for the mock Auth server. supabase-js reads the claims (the assurance level
 * among them) but never checks the signature, so the signature is a fixed placeholder. Built
 * at run time so no token-shaped string sits in the tree.
 */

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface TokenClaims {
  sub: string;
  email: string;
  aal: 'aal1' | 'aal2';
  sessionId: string;
}

/** Valid for a day from now. */
export function makeAccessToken(claims: TokenClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: 'http://supabase.mock.test/auth/v1',
    aud: 'authenticated',
    role: 'authenticated',
    sub: claims.sub,
    email: claims.email,
    aal: claims.aal,
    amr: claims.aal === 'aal2'
      ? [{ method: 'totp', timestamp: now }, { method: 'password', timestamp: now }]
      : [{ method: 'password', timestamp: now }],
    session_id: claims.sessionId,
    iat: now,
    exp: now + 86_400,
  };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.${base64url('mock-signature')}`;
}

/** The `sub` and `aal` claims of a token this module made; null for the anon key or anything else. */
export function readToken(token: string | null | undefined): { sub: string; aal: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      sub?: unknown;
      aal?: unknown;
    };
    return typeof payload.sub === 'string' ? { sub: payload.sub, aal: String(payload.aal ?? 'aal1') } : null;
  } catch {
    return null;
  }
}
