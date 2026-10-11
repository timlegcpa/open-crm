// Who is calling, decided by the database, never by a claim read here.
//
//   owner   the token is a live session (Auth getUser, through the service client) AND
//           public.is_owner() answers true when asked AS THE CALLER, with the caller's
//           own token: the owner row plus the MFA level and recovery lockout in the
//           same claims PostgREST sees.
//   client  a live session whose public.get_client_contact_id(), asked as the caller,
//           names a contact (an active portal account, MFA satisfied), plus whether
//           this exact session is the owner's "View as client" session.
//
// View as client mints the client's own ordinary session, so nothing in the token says
// the owner is holding it. public.is_impersonation_session(p_user, p_session) is the one
// rule: a session bound to an impersonation row is restricted for as long as it exists;
// an unbound open row restricts the whole user (and for the magic link's hour after).
// The lookup fails CLOSED: an error, or any answer but false, means impersonating.
//
// Outcomes: 401 for no live session, 403 for a live session that is not this
// principal. A thrown error (Auth or the database unreachable) is the handler's to map;
// createHandler answers it as signed out.
//
// Clients are passed in, never imported, so this file runs under vitest and Deno alike.

import { isUuid } from './http.ts';
import { createLogger } from './log.ts';

export interface OwnerPrincipal {
  kind: 'owner';
  userId: string;
}

export interface ClientPrincipal {
  kind: 'client';
  userId: string;
  contactId: string;
  /** The token's session_id claim; null when it carries none. */
  sessionId: string | null;
  /** True for the owner's View-as-client session, and whenever that could not be ruled out. */
  impersonating: boolean;
}

export type AuthOutcome<P> = { ok: true; principal: P } | { ok: false; status: 401 | 403 };

/** The slices of a Supabase client this module calls. supabase-js clients satisfy them. */
export interface RpcCaller {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface AuthServiceClient extends RpcCaller {
  auth: {
    getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
  };
}

export interface AuthDeps {
  /** The service-role client: verifies the session and runs the impersonation lookup. */
  service: AuthServiceClient;
  /** A client that sends the caller's token, so the database sees the caller's claims. */
  asCaller(token: string): RpcCaller;
}

const log = createLogger('auth');

/** The verified user's id, or null when the token is not a live session. */
async function liveUserId(deps: AuthDeps, token: string): Promise<string | null> {
  const { data, error } = await deps.service.auth.getUser(token);
  const id = data?.user?.id;
  return error || typeof id !== 'string' || !id ? null : id;
}

export async function authorizeOwner(deps: AuthDeps, token: string): Promise<AuthOutcome<OwnerPrincipal>> {
  const userId = await liveUserId(deps, token);
  if (!userId) return { ok: false, status: 401 };
  const { data, error } = await deps.asCaller(token).rpc('is_owner');
  if (error) throw error;
  if (data !== true) return { ok: false, status: 403 };
  return { ok: true, principal: { kind: 'owner', userId } };
}

export async function authorizeClient(deps: AuthDeps, token: string): Promise<AuthOutcome<ClientPrincipal>> {
  const userId = await liveUserId(deps, token);
  if (!userId) return { ok: false, status: 401 };
  const { data: contactId, error } = await deps.asCaller(token).rpc('get_client_contact_id');
  if (error) throw error;
  if (!isUuid(contactId)) return { ok: false, status: 403 };
  const sessionId = jwtSessionId(token);
  let impersonating = true;
  try {
    const res = await deps.service.rpc('is_impersonation_session', { p_user: userId, p_session: sessionId });
    if (res.error) log.error('impersonation lookup failed; treating as View as client', res.error);
    else impersonating = res.data !== false;
  } catch (err) {
    log.error('impersonation lookup failed; treating as View as client', err);
  }
  return { ok: true, principal: { kind: 'client', userId, contactId, sessionId, impersonating } };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session_id claim of an access token, or null. Reads the payload without checking
 * the signature, so only call it on a token Auth has already accepted.
 */
export function jwtSessionId(token: string): string | null {
  const part = token.replace(/^Bearer\s+/i, '').split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { session_id?: unknown };
    const sid = payload.session_id;
    return typeof sid === 'string' && SESSION_ID.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

/** Options every edge client is created with: no stored session, no background refresh. */
export interface EdgeClientOptions {
  auth: { persistSession: false; autoRefreshToken: false; detectSessionInUrl: false };
  global?: { headers: Record<string, string> };
}

/**
 * The two clients a function needs, from the createClient it imports:
 *   service           the service role, for server reads and writes (bypasses RLS)
 *   asCaller(token)   the anon key plus the caller's token, so RLS and the principal
 *                     functions see the caller
 */
export function supabaseClients<C>(
  createClient: (url: string, key: string, options: EdgeClientOptions) => C,
  config: { supabaseUrl: string; anonKey: string; serviceRoleKey: string },
): { service: C; asCaller(token: string): C } {
  const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
  return {
    service: createClient(config.supabaseUrl, config.serviceRoleKey, { auth }),
    asCaller: (token: string) =>
      createClient(config.supabaseUrl, config.anonKey, { auth, global: { headers: { Authorization: `Bearer ${token}` } } }),
  };
}
