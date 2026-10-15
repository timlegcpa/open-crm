import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createLogger } from '../_shared/log.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { checkPublicLimits } from '../_shared/rate-limit.ts';
import { createAcceptInviteHandler, type InvitationRow } from './handler.ts';
import { PORTAL_USER_BAN_DURATION, PORTAL_USER_BAN_LIFTED } from '../_shared/portal-account.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const log = createLogger('accept-portal-invite');

/** Supabase Auth's answer for an address it already holds. */
function isAlreadyRegistered(error: { code?: unknown; message?: unknown }): boolean {
  return error.code === 'email_exists' || /already been registered/i.test(String(error.message ?? ''));
}

Deno.serve(
  createAcceptInviteHandler({
    allowedOrigins: config.allowedOrigins,

    rateLimit: ({ ip, userAgent }) =>
      checkPublicLimits(server, {
        action: 'accept_portal_invite',
        ip,
        userAgent,
        perIp: { max: 20, windowMinutes: 10 },
        global: { max: 300, windowMinutes: 10 },
      }),

    async findInvitation(tokenHash) {
      const { data, error } = await server
        .from('portal_invitations')
        .select('id, contact_id, email, status, expires_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (error) throw error;
      return (data as InvitationRow | null) ?? null;
    },

    async markExpired(invitationId) {
      const { error } = await server.from('portal_invitations').update({ status: 'expired' }).eq('id', invitationId).eq('status', 'pending');
      if (error) throw error;
    },

    async countAttempt(invitationId) {
      const { data, error } = await server.rpc('increment_invitation_attempt', { invitation_id: invitationId, max_attempts: 5 });
      if (error) throw error;
      return typeof data === 'number' ? data : null;
    },

    async createBannedUser({ email, password, displayName, invitationId }) {
      const { data, error } = await server.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        ban_duration: PORTAL_USER_BAN_DURATION,
        // No role claim: who this user is, the database decides (an active portal account).
        app_metadata: { pending_invite: invitationId },
        user_metadata: { display_name: displayName },
      });
      if (error) {
        if (isAlreadyRegistered(error)) return { alreadyRegistered: true };
        throw error;
      }
      return { userId: data.user.id };
    },

    async findUserIdByEmail(email) {
      const { data, error } = await server.rpc('find_auth_user_id_by_email', { target_email: email });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async claim(invitationId, claim) {
      const { data, error } = await server.rpc('claim_portal_invitation', { p_invitation_id: invitationId, p_claim: claim });
      if (error) throw error;
      return data === true;
    },

    async releaseClaim(invitationId, claim) {
      const { error } = await server.rpc('release_portal_invitation_claim', { p_invitation_id: invitationId, p_claim: claim });
      if (error) throw error;
    },

    async deleteStaleUser(userId, invitationId, claim) {
      const { data, error } = await server.rpc('delete_stale_portal_user', { p_user: userId, p_invitation_id: invitationId, p_claim: claim });
      if (error) throw error;
      return data === true;
    },

    async deleteUser(userId) {
      const { error } = await server.auth.admin.deleteUser(userId);
      if (error && error.status !== 404) throw error;
    },

    async banUser(userId) {
      const { error } = await server.auth.admin.updateUserById(userId, { ban_duration: PORTAL_USER_BAN_DURATION });
      if (error) throw error;
    },

    async link(invitationId, userId) {
      const { data, error } = await server.rpc('link_portal_invitation', { p_invitation_id: invitationId, p_user_id: userId });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async activateUser(userId) {
      const { error } = await server.auth.admin.updateUserById(userId, {
        ban_duration: PORTAL_USER_BAN_LIFTED,
        app_metadata: { pending_invite: null },
      });
      if (error) throw error;
    },

    async markAccepted(invitationId) {
      const { error } = await server
        .from('portal_invitations')
        .update({ status: 'accepted', accepted_at: new Date().toISOString(), token_hash: null })
        .eq('id', invitationId);
      if (error) throw error;
    },

    async logAccepted({ contactId, userId, invitationId, ip, userAgent }) {
      const { error } = await server.from('client_activity_log').insert({
        contact_id: contactId,
        user_id: userId,
        action: 'invitation_accepted',
        details: { invitation_id: invitationId, actor_role: 'client' },
        ip_address: ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null,
      });
      if (error) throw error;
    },

    async notifyOwner({ contactId, invitationId, email, displayName }) {
      const { data: profile, error } = await server.from('org_profile').select('owner_user_id').maybeSingle();
      if (error) throw error;
      const ownerId = (profile as { owner_user_id?: string } | null)?.owner_user_id;
      if (!ownerId) return;
      const { data: owner } = await server.auth.admin.getUserById(ownerId);
      const to = owner?.user?.email;
      if (!to || !config.siteUrl) {
        log.warn('owner notice skipped: no owner address or SITE_URL');
        return;
      }
      const identity = await org.load();
      const who = displayName || email;
      const message = renderEmail(identity, {
        preheader: `${who} set up their portal account.`,
        blocks: [
          { kind: 'heading', text: 'Portal account ready' },
          { kind: 'paragraph', text: `${who} (${email}) has set up their client portal account.` },
          { kind: 'button', label: 'Open the contact', url: `${config.siteUrl}/contacts/${contactId}` },
        ],
      });
      const result = await outbound.sendEmail({
        to,
        subject: `Portal account ready: ${who.replace(/[\r\n]+/g, ' ')}`,
        html: message.html,
        text: message.text,
        fromName: identity.senderName,
        idempotencyKey: `portal-accepted:${invitationId}`,
      });
      if (result.status !== 'sent') log.warn('owner notice not sent', { status: result.status });
    },
  }),
);
