import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { inviteContent, inviteSubject } from '../invite-client-portal/invite-email.ts';
import { createResendHandler, type Greeting, type PortalAccountRow } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const auditLog = createAudit({ db: server });

Deno.serve(
  createResendHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async loadAccount(accountId) {
      const { data, error } = await server
        .from('client_portal_accounts')
        .select('id, contact_id, user_id, status, invited_email')
        .eq('id', accountId)
        .maybeSingle();
      if (error) throw error;
      return (data as PortalAccountRow | null) ?? null;
    },

    async throttled(contactId) {
      const { data, error } = await server.rpc('portal_invite_throttled', { p_contact_id: contactId });
      if (error) throw error;
      return data === true;
    },

    async deleteAuthUser(userId) {
      const { error } = await server.auth.admin.deleteUser(userId);
      if (error && error.status !== 404) throw error;
    },

    async reissue({ accountId, tokenHash, expiresAt, invitedBy }) {
      const { data, error } = await server.rpc('reissue_portal_invitation', {
        p_account_id: accountId,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt.toISOString(),
        p_invited_by: invitedBy,
      });
      if (error) throw error;
      const [row] = data as Array<{ invitation_id: string; contact_id: string; email: string }>;
      return { invitationId: row.invitation_id, contactId: row.contact_id, email: row.email };
    },

    async loadGreeting(contactId) {
      const { data, error } = await server
        .from('contacts')
        .select('first_name, spouse_first_name, spouse_email')
        .eq('id', contactId)
        .maybeSingle();
      if (error) throw error;
      return (data as Greeting | null) ?? null;
    },

    async sendInvite({ to, firstName, url, expiresAt, variant, invitationId }) {
      const identity = await org.load();
      const message = renderEmail(identity, inviteContent({ org: identity, variant, firstName, url, expiresAt }));
      return outbound.sendEmail({
        to,
        subject: inviteSubject(identity, variant),
        html: message.html,
        text: message.text,
        fromName: identity.senderName,
        idempotencyKey: `portal-invite:${invitationId}`,
      });
    },

    async audit({ ownerId, action, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action, details, ip, userAgent });
    },
  }),
);
