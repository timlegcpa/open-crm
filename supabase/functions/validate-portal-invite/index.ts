import { createClient } from '@supabase/supabase-js';
import { supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { checkPublicLimits } from '../_shared/rate-limit.ts';
import { createValidateInviteHandler, type InvitationRow, type InviteeContact } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const server = supabaseClients(createClient, config).service;

Deno.serve(
  createValidateInviteHandler({
    allowedOrigins: config.allowedOrigins,

    // Per address first, then the ceiling every address shares (see checkPublicLimits).
    rateLimit: ({ ip, userAgent }) =>
      checkPublicLimits(server, {
        action: 'validate_portal_invite',
        ip,
        userAgent,
        perIp: { max: 60, windowMinutes: 10 },
        global: { max: 1000, windowMinutes: 10 },
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
      const { error } = await server
        .from('portal_invitations')
        .update({ status: 'expired' })
        .eq('id', invitationId)
        .eq('status', 'pending');
      if (error) throw error;
    },

    async loadContact(contactId) {
      const { data, error } = await server
        .from('contacts')
        .select('first_name, last_name, spouse_first_name, spouse_last_name, spouse_email')
        .eq('id', contactId)
        .maybeSingle();
      if (error) throw error;
      return (data as InviteeContact | null) ?? null;
    },
  }),
);
