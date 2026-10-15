import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createLogger } from '../_shared/log.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { loadOwnerEmail } from '../_shared/owner.ts';
import { PORTAL_USER_BAN_DURATION, PORTAL_USER_BAN_LIFTED } from '../_shared/portal-account.ts';
import { checkPublicLimits } from '../_shared/rate-limit.ts';
import { clientDisplayName, ownerContactUrl, startLinkAccountOwnerEmail } from '../send-needs-list/needs-email.ts';
import { createAcceptStartLinkHandler, type StartLinkRow } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const log = createLogger('accept-start-link');

/** Supabase Auth's answer for an address it already holds. */
function isAlreadyRegistered(error: { code?: unknown; message?: unknown }): boolean {
  return error.code === 'email_exists' || /already been registered/i.test(String(error.message ?? ''));
}

Deno.serve(
  createAcceptStartLinkHandler({
    allowedOrigins: config.allowedOrigins,

    rateLimit: ({ ip, userAgent }) =>
      checkPublicLimits(server, {
        action: 'accept_start_link',
        ip,
        userAgent,
        perIp: { max: 5, windowMinutes: 10 },
        global: { max: 300, windowMinutes: 10 },
      }),

    async lookup(tokenHash) {
      const { data, error } = await server.rpc('start_link_lookup', { p_token_hash: tokenHash });
      if (error) throw error;
      return ((data as StartLinkRow[] | null) ?? [])[0] ?? null;
    },

    async expire(linkId) {
      const { error } = await server.rpc('expire_start_link', { p_id: linkId });
      if (error) throw error;
    },

    async claim(linkId, claim) {
      const { data, error } = await server.rpc('claim_start_link', { p_id: linkId, p_claim: claim });
      if (error) throw error;
      return data === true;
    },

    async releaseClaim(linkId, claim) {
      const { error } = await server.rpc('release_start_link_claim', { p_id: linkId, p_claim: claim });
      if (error) throw error;
    },

    async createBannedUser({ email, password, linkId }) {
      const { data, error } = await server.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        ban_duration: PORTAL_USER_BAN_DURATION,
        // No role claim: who this user is, the database decides (an active portal account).
        app_metadata: { pending_signup: linkId },
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

    async deleteStaleUser(userId, linkId, claim) {
      const { data, error } = await server.rpc('delete_stale_start_link_user', { p_user: userId, p_id: linkId, p_claim: claim });
      if (error) throw error;
      return data === true;
    },

    async banUser(userId) {
      const { error } = await server.auth.admin.updateUserById(userId, { ban_duration: PORTAL_USER_BAN_DURATION });
      if (error) throw error;
    },

    async deleteUser(userId) {
      const { error } = await server.auth.admin.deleteUser(userId);
      if (error && error.status !== 404) throw error;
    },

    async link(linkId, userId, claim) {
      const { data, error } = await server.rpc('link_start_link', { p_id: linkId, p_user_id: userId, p_claim: claim });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async activateUser(userId) {
      const { error } = await server.auth.admin.updateUserById(userId, {
        ban_duration: PORTAL_USER_BAN_LIFTED,
        app_metadata: { pending_signup: null },
      });
      if (error) throw error;
    },

    async retire(linkId) {
      const { data, error } = await server.rpc('retire_start_link', { p_id: linkId });
      if (error) throw error;
      return (data as string[] | null) ?? [];
    },

    async logConsumed({ contactId, userId, linkId, revokedInvites, ip, userAgent }) {
      const { error } = await server.from('client_activity_log').insert({
        contact_id: contactId,
        user_id: userId,
        action: 'start_link_consumed',
        details: { pending_request_id: linkId, revoked_invites: revokedInvites, actor_role: 'client' },
        ip_address: ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null,
      });
      if (error) throw error;
    },

    async notifyOwner({ contactId, linkId, email }) {
      const to = await loadOwnerEmail(server);
      if (!to || !config.siteUrl) {
        log.warn('owner notice skipped: no owner address or SITE_URL');
        return;
      }
      const { data } = await server.from('contacts').select('first_name, last_name, business_name').eq('id', contactId).maybeSingle();
      const identity = await org.load();
      const { subject, content } = startLinkAccountOwnerEmail({
        clientName: clientDisplayName(data as { first_name: string | null; last_name: string | null; business_name: string | null } | null),
        email,
        url: ownerContactUrl(config.siteUrl, contactId),
      });
      const message = renderEmail(identity, content);
      const result = await outbound.sendEmail({
        to, subject, html: message.html, text: message.text, fromName: identity.senderName, idempotencyKey: `start-link-consumed:${linkId}`,
      });
      if (result.status !== 'sent') log.warn('owner notice not sent', { status: result.status });
    },
  }),
);
