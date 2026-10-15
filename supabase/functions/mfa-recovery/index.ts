import { createClient } from '@supabase/supabase-js';
import { sessionUserId, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { loadOwnerEmail } from '../_shared/owner.ts';
import { checkPublicLimits, checkUserLimit } from '../_shared/rate-limit.ts';
import { createBackupCodeHasher } from '../_shared/mfa-backup-code.ts';
import { createMfaRecoveryHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const hashCode = createBackupCodeHasher(config.serviceRoleKey);
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });

async function emailOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data, error } = await server.auth.admin.getUserById(userId);
  if (error) throw error;
  return data.user?.email ?? null;
}

Deno.serve(
  createMfaRecoveryHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,

    publicLimits: (ip, userAgent) =>
      checkPublicLimits(server, {
        action: 'mfa_recovery',
        ip,
        userAgent,
        perIp: { max: 10, windowMinutes: 15 },
        global: { max: 100, windowMinutes: 15 },
      }),
    userLimit: (userId) => checkUserLimit(server, { action: 'mfa_recovery', userId, max: 5, windowMinutes: 15 }),
    sessionUserId: (token) => sessionUserId(clients, token),

    async accountKind(userId) {
      const { data, error } = await server.from('org_profile').select('owner_user_id, system_user_id').maybeSingle();
      if (error) throw error;
      const row = data as { owner_user_id?: unknown; system_user_id?: unknown } | null;
      if (!row || row.system_user_id === userId) return null;
      if (row.owner_user_id === userId) return 'owner';
      const accounts = await server
        .from('client_portal_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .limit(1);
      if (accounts.error) throw accounts.error;
      return (accounts.data ?? []).length > 0 ? 'client' : null;
    },

    async isViewAsClient(userId, sessionId) {
      try {
        const { data, error } = await server.rpc('is_impersonation_session', { p_user: userId, p_session: sessionId });
        return error ? true : data !== false;
      } catch {
        return true;
      }
    },

    async addresses(userId) {
      return { account: await emailOf(userId), owner: await loadOwnerEmail(server) };
    },

    hashCode,

    async claim(userId, hash) {
      const { data, error } = await server.rpc('mfa_backup_code_claim', { p_user_id: userId, p_hash: hash });
      if (error) throw error;
      return data as { state?: unknown; id?: unknown; lease?: unknown; alerted?: unknown } | null;
    },

    async release(codeId, userId, lease) {
      const { error } = await server.rpc('mfa_backup_code_release', { p_id: codeId, p_user_id: userId, p_lease: lease });
      if (error) throw error;
    },

    async sendEmail(message) {
      const identity = await org.load();
      const { html, text } = renderEmail(identity, message.content);
      const result = await outbound.sendEmail({
        to: message.to,
        subject: message.subject,
        html,
        text,
        fromName: identity.senderName,
        idempotencyKey: message.idempotencyKey,
      });
      return result.status === 'sent';
    },

    async stampAlert(codeId, userId, lease) {
      const { data, error } = await server.rpc('mfa_backup_code_alerted', { p_id: codeId, p_user_id: userId, p_lease: lease });
      if (error) throw error;
      return data === true;
    },

    async renewLease(codeId, userId, lease) {
      const { data, error } = await server.rpc('mfa_backup_code_lease_renew', { p_id: codeId, p_user_id: userId, p_lease: lease });
      if (error) throw error;
      return data === true;
    },

    async signOutEverywhere(token) {
      const { error } = await server.auth.admin.signOut(token, 'global');
      if (error) throw error;
    },

    async finalize(codeId, userId, lease, ip, userAgent) {
      const { error } = await server.rpc('mfa_backup_code_finalize', {
        p_id: codeId,
        p_user_id: userId,
        p_lease: lease,
        p_ip: ip,
        p_user_agent: userAgent,
      });
      if (error) throw error;
    },
  }),
);
