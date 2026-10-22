import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { createChangePortalEmailHandler, type CheckOutcome, type SetOutcome } from './handler.ts';
import { signInChangedContent, signInChangedSubject } from './notice.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const auditLog = createAudit({ db: server });

Deno.serve(
  createChangePortalEmailHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async check(accountId, email, expected) {
      const { data, error } = await server.rpc('portal_login_for_change', { p_account_id: accountId, p_email: email, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: CheckOutcome; user_id?: string; contact_id?: string };
    },

    async currentSignInEmail(userId) {
      const { data, error } = await server.auth.admin.getUserById(userId);
      if (error) throw error;
      return data.user?.email ?? null;
    },

    async setSignInEmail(userId, email) {
      const { error } = await server.auth.admin.updateUserById(userId, { email, email_confirm: true });
      if (!error) return 'changed';
      // A 4xx is Auth refusing (an address in use, a malformed one): nothing moved.
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return 'refused';
      throw error;
    },

    async setRecord(accountId, email, expected) {
      const { data, error } = await server.rpc('portal_set_login_email', { p_account_id: accountId, p_email: email, p_expected_email: expected });
      if (error) throw error;
      return data as { outcome: SetOutcome; contact_id?: string; contact_address?: string };
    },

    async sendNotice({ to, accountId, newEmail }) {
      const identity = await org.load();
      const message = renderEmail(identity, signInChangedContent(identity));
      const sent = await outbound.sendEmail({
        to,
        subject: signInChangedSubject(identity),
        html: message.html,
        text: message.text,
        fromName: identity.senderName,
        // One notice per change, never an address in the key the provider sees.
        idempotencyKey: `portal-sign-in-changed:${accountId}:${(await sha256Hex(newEmail.toLowerCase())).slice(0, 32)}`,
      });
      return sent.status;
    },

    async audit({ ownerId, action, details, ip, userAgent }) {
      await auditLog.write({ actorId: ownerId, action, details, ip, userAgent });
    },
  }),
);
