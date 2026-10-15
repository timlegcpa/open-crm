import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createLogger } from '../_shared/log.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { checkUserLimit } from '../_shared/rate-limit.ts';
import {
  createGroupEmailHandler,
  MAX_CAMPAIGNS_PER_HOUR,
  type ClaimResult,
  type ContactRow,
  type ReplayResult,
} from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const outboundEnv = readOutboundEnv((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: outboundEnv, db: server, log: createLogger('crm-send-group-email.outbound') });

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await server.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

Deno.serve(
  createGroupEmailHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    siteUrl: config.siteUrl,
    oneClickUrl: `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/email-unsubscribe`,
    outboundEnv,

    checkSendLimit: (ownerId) =>
      checkUserLimit(server, { action: 'group_email', userId: ownerId, max: MAX_CAMPAIGNS_PER_HOUR, windowMinutes: 60 }),

    loadOrg: () => org.load(),

    // At most 250 ids, so one read inside PostgREST's 1,000-row cap.
    async readContacts(ids) {
      const { data, error } = await server.from('contacts').select('id, first_name, email, status').in('id', ids);
      if (error) throw error;
      return (data ?? []) as ContactRow[];
    },

    // At most 250 addresses, and stored addresses are normalized, so an exact IN is complete.
    async readSuppressed(addresses) {
      const { data, error } = await server.from('email_suppressions').select('address').in('address', addresses);
      if (error) throw error;
      return ((data ?? []) as { address: string }[]).map((r) => r.address);
    },

    begin: (input) =>
      rpc<string | null>('group_email_begin', {
        p_idempotency_key: input.idempotencyKey,
        p_created_by: input.createdBy,
        p_subject: input.subject,
        p_body: input.body,
        p_from_identity: input.fromIdentity,
        p_audience_description: input.audienceDescription,
        p_recipients: input.recipients,
        p_skips: input.skips,
        p_tokens: input.tokens,
        p_skipped_count: input.skippedCount,
      }),

    replay: (key) => rpc<ReplayResult>('group_email_replay', { p_idempotency_key: key }),

    claim: (campaignId, address, emailable) =>
      rpc<ClaimResult>('group_email_claim', { p_campaign_id: campaignId, p_address: address, p_emailable: emailable }),

    async record(campaignId, address, outcome, providerMessageId, error) {
      await rpc('group_email_record', {
        p_campaign_id: campaignId,
        p_address: address,
        p_status: outcome,
        p_provider_message_id: providerMessageId,
        p_error: error,
      });
    },

    async finish(campaignId, counts) {
      await rpc('group_email_finish', {
        p_campaign_id: campaignId,
        p_sent: counts.sent,
        p_failed: counts.failed,
        p_unknown: counts.unknown,
        p_skipped: counts.skipped,
      });
    },

    sendEmail: (message) => outbound.sendEmail(message),

    // Ids and counts only: the subject is the owner's free text and stays out of the log.
    audit: (ownerId, details, userAgent) =>
      auditLog.write({ actorId: ownerId, action: 'group_email_sent', details, userAgent }),
  }),
);
