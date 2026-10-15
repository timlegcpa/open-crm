import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { loadOwnerEmail } from '../_shared/owner.ts';
import { checkPublicLimits } from '../_shared/rate-limit.ts';
import { createLeadIntakeHandler, type RecordResult } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });

Deno.serve(
  createLeadIntakeHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,

    async loadKeyHash() {
      const { data, error } = await server.from('lead_intake_keys').select('key_hash').maybeSingle();
      if (error) throw error;
      const hash = (data as { key_hash?: unknown } | null)?.key_hash;
      return typeof hash === 'string' ? hash : null;
    },

    rateLimit: (ip, userAgent) =>
      checkPublicLimits(server, {
        action: 'lead_intake',
        ip,
        userAgent,
        perIp: { max: 30, windowMinutes: 10 },
        global: { max: 60, windowMinutes: 10 },
      }),

    async record(lead, note) {
      const { data, error } = await server.rpc('lead_intake_record', {
        p_external_id: lead.external_id,
        p_first_name: lead.first_name,
        p_last_name: lead.last_name,
        p_email: lead.email,
        p_phone: lead.phone,
        p_business_name: lead.business_name,
        p_note: note,
      });
      if (error) throw error;
      return data as RecordResult;
    },

    async notifyOwner(message) {
      const to = await loadOwnerEmail(server);
      if (!to) return false;
      const identity = await org.load();
      const { html, text } = renderEmail(identity, message.content);
      const result = await outbound.sendEmail({
        to,
        subject: message.subject,
        html,
        text,
        fromName: identity.senderName,
        idempotencyKey: message.idempotencyKey,
      });
      return result.status === 'sent';
    },
  }),
);
