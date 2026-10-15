import { publicProjectConfig } from '@/lib/publicEdge';
import { PASSWORD_RULES_TEXT } from '@/lib/passwordRules';

/**
 * Password recovery over Supabase Auth's REST API with plain fetch. The two public pages
 * that use it render with no session and must not load supabase-js
 * (publicRoutes.test.tsx), so they cannot use the client's own recovery calls.
 */

export type AuthRestResult = { ok: true } | { ok: false; status: number; code: string | null };

const NOT_CONNECTED: AuthRestResult = { ok: false, status: 0, code: 'not_connected' };

async function call(path: string, init: { method: string; body?: unknown; token?: string }): Promise<AuthRestResult> {
  const config = publicProjectConfig();
  if (!config) return NOT_CONNECTED;
  const headers: Record<string, string> = { apikey: config.anonKey, 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let response: Response;
  try {
    response = await fetch(`${config.url}/auth/v1/${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { ok: false, status: 0, code: 'network' };
  }
  if (response.ok) return { ok: true };
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error_code?: unknown; code?: unknown };
    const value = body.error_code ?? body.code;
    code = typeof value === 'string' ? value : null;
  } catch {
    // An unreadable error body: the status alone decides.
  }
  return { ok: false, status: response.status, code };
}

/** Asks Auth to email a reset link that lands on `redirectTo`. */
export function requestPasswordReset(email: string, redirectTo: string): Promise<AuthRestResult> {
  return call(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email } });
}

/** Sets a new password with the recovery link's access token. */
export function setPasswordWithToken(token: string, password: string): Promise<AuthRestResult> {
  return call('user', { method: 'PUT', token, body: { password } });
}

/** Ends every session of the account, the recovery one included. Best effort. */
export function signOutEverywhere(token: string): Promise<AuthRestResult> {
  return call('logout?scope=global', { method: 'POST', token });
}

export interface RecoveryLink {
  token: string | null;
  /** Auth's own error code from the link (otp_expired, access_denied), when it carried one. */
  error: string | null;
}

/** Reads a recovery link's fragment: `#access_token=...&type=recovery`, or `#error=...`. */
export function readRecoveryHash(hash: string): RecoveryLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const error = params.get('error_code') ?? params.get('error');
  if (error) return { token: null, error };
  const token = params.get('access_token');
  if (token && params.get('type') === 'recovery') return { token, error: null };
  return { token: null, error: null };
}

/** What a refused password change tells the person. */
export function resetErrorMessage(status: number, code: string | null): string {
  if (code === 'insufficient_aal') {
    return 'Two-factor is on for this account, so a reset link alone cannot change the password. Sign in with your password and authenticator code, or ask for help.';
  }
  if (code === 'same_password') return 'Choose a password different from the current one.';
  if (code === 'weak_password') return PASSWORD_RULES_TEXT;
  if (status === 401 || status === 403) return 'This reset link has expired. Ask for a new one.';
  if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
  if (status === 0) return 'Could not reach the server. Try again.';
  return 'The password was not changed. Try again.';
}
