import { createClient } from '@supabase/supabase-js';
import { publicProjectConfig } from './publicEdge';
import { getSupabase } from './supabase';

// Changing the signed-in account's password, for the owner (Settings, Security) and for a
// client (portal Profile). One implementation, so the two screens cannot drift apart on the
// part that keeps a two-factor session alive.

export type PasswordChangeResult = 'ok' | 'reauthentication_needed' | 'code_not_valid';

/**
 * Sets the signed-in account's password. With Auth's secure password change on
 * (supabase/config.toml), a session without a recent sign-in is refused
 * (`reauthentication_needed`) until the change carries the code Auth emails on
 * `sendReauthenticationCode()`, passed here as `nonce`. That is the server's own check; the
 * current-password check in the browser is only the fast path. Any other refusal throws.
 */
export async function changePassword(password: string, nonce?: string): Promise<PasswordChangeResult> {
  const { error } = await getSupabase().auth.updateUser(nonce ? { password, nonce } : { password });
  if (!error) return 'ok';
  const code = (error as { code?: unknown }).code;
  if (code === 'reauthentication_needed') return 'reauthentication_needed';
  if (code === 'reauthentication_not_valid') return 'code_not_valid';
  throw error;
}

/** Asks Auth to email the signed-in account a one-time code for `changePassword`. */
export async function sendReauthenticationCode(): Promise<void> {
  const { error } = await getSupabase().auth.reauthenticate();
  if (error) throw error;
}

/**
 * Checks the current password on a throwaway client that keeps nothing: no stored session,
 * no refresh, its own storage key. Signing in on the app's own client would replace a
 * two-factor (aal2) session with a password-only one: the second-factor gate would take
 * over the screen, and the next protected call (the owner's audit row for this very change)
 * would be refused. The throwaway session is signed out at once.
 */
export async function verifyCurrentPassword(email: string, password: string): Promise<boolean> {
  const config = publicProjectConfig();
  if (!config) throw new Error('This app is not connected to its server yet.');
  const throwaway = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'open-crm-reauth' },
  });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (data.session) await throwaway.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return !error && Boolean(data.session);
}
