import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { createInviteHandler, type ContactEmailRow, type InviteContact } from './handler.ts';
import { inviteContent, inviteSubject } from './invite-email.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const auditLog = createAudit({ db: server });

Deno.serve(
  createInviteHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async loadContact(contactId) {
      const { data, error } = await server
        .from('contacts')
        .select('id, first_name, spouse_first_name, email')
        .eq('id', contactId)
        .maybeSingle();
      if (error) throw error;
      return (data as InviteContact | null) ?? null;
    },

    async contactEmails(contactId) {
      const { data, error } = await server.from('contact_emails').select('email, kind').eq('contact_id', contactId);
      if (error) throw error;
      return (data as ContactEmailRow[] | null) ?? [];
    },

    async createInvitation({ contactId, email, tokenHash, expiresAt, invitedBy }) {
      const { data, error } = await server.rpc('create_portal_invitation', {
        p_contact_id: contactId,
        p_email: email,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt.toISOString(),
        p_invited_by: invitedBy,
      });
      if (error) throw error;
      return data as string;
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
