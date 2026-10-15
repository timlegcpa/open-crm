import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createImpersonateHandler, type TargetAccount, type TargetContact } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

/** A client with no stored session, for redeeming the link: what it yields is handed on, never kept. */
function linkRedeemer() {
  return createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

Deno.serve(
  createImpersonateHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async sweepStale() {
      const { data, error } = await server.rpc('auto_end_stale_impersonation_sessions');
      if (error) throw error;
      return typeof data === 'number' ? data : 0;
    },

    async activeAccounts(contactId) {
      const { data, error } = await server
        .from('client_portal_accounts')
        .select('user_id')
        .eq('contact_id', contactId)
        .eq('status', 'active')
        .not('user_id', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return (data as TargetAccount[] | null) ?? [];
    },

    async loadContact(contactId) {
      const { data, error } = await server.from('contacts').select('email, full_name').eq('id', contactId).maybeSingle();
      if (error) throw error;
      return (data as TargetContact | null) ?? null;
    },

    async getAuthUser(userId) {
      const { data, error } = await server.auth.admin.getUserById(userId);
      if (error || !data.user) return null;
      const user = data.user as { id: string; email?: string; banned_until?: string | null };
      return { id: user.id, email: user.email ?? null, bannedUntil: user.banned_until ?? null };
    },

    async staffIds() {
      const { data, error } = await server.from('org_profile').select('owner_user_id, system_user_id').maybeSingle();
      if (error) throw error;
      const row = (data ?? {}) as { owner_user_id?: string | null; system_user_id?: string | null };
      return [row.owner_user_id, row.system_user_id].filter((id): id is string => typeof id === 'string');
    },

    async aal1Refused(userId) {
      const { data, error } = await server.rpc('mfa_guard_denied', {
        p_user_id: userId,
        p_aal: 'aal1',
        p_iat: Math.floor(Date.now() / 1000),
      });
      if (error) throw error;
      return data !== false;
    },

    async mintSession(email) {
      const { data: link, error: linkError } = await server.auth.admin.generateLink({ type: 'magiclink', email });
      const hashed = link?.properties?.hashed_token;
      if (linkError || !hashed) throw linkError ?? new Error('no hashed token');
      const { data, error } = await linkRedeemer().auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
      if (error || !data.session) throw error ?? new Error('no session');
      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
      };
    },

    async revokeMinted(accessToken) {
      const { error } = await server.auth.admin.signOut(accessToken, 'local');
      if (error) throw error;
    },

    async insertSession({ ip, ...row }) {
      // ip is the handler context ip (getClientIp), passed through unchanged.
      const { data, error } = await server
        .from('impersonation_sessions')
        .insert({
          owner_user_id: row.ownerId,
          target_contact_id: row.contactId,
          target_user_id: row.targetUserId,
          target_email: row.targetEmail,
          target_name: row.targetName,
          session_id: row.sessionId,
          ip_address: ip,
          user_agent: row.userAgent ? row.userAgent.slice(0, 512) : null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    },

    async audit({ ownerId, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action: 'impersonate_start', details, ip, userAgent });
    },
  }),
);
