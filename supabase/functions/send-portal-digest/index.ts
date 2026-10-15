import { createClient } from '@supabase/supabase-js';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createLogger } from '../_shared/log.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, isValidEmail, readOutboundEnv } from '../_shared/outbound.ts';
import { fetchAllPaged, PAGE_SIZE } from '../_shared/paging.ts';
import { createDigestHandler, type ActivityRow, type MessageCount, type ViewWindow } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });
const log = createLogger('send-portal-digest');

interface NameParts {
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
}

function nameOf(contact: NameParts | NameParts[] | null): string {
  const c = Array.isArray(contact) ? contact[0] : contact;
  const person = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
  return person || c?.business_name?.trim() || 'Unknown contact';
}

/** PostgREST's answer for a table this project does not have. */
function isMissingTable(error: { code?: unknown }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205';
}

Deno.serve(
  createDigestHandler({
    allowedOrigins: config.allowedOrigins,
    cronSecret: Deno.env.get('CRON_SHARED_SECRET'),
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async listActivitySince(sinceIso) {
      type Raw = { id: string; contact_id: string; action: string; created_at: string; details: Record<string, unknown> | null; contacts: NameParts | null };
      const rows = await fetchAllPaged<Raw>((afterId) => {
        let q = server
          .from('client_activity_log')
          .select('id, contact_id, action, created_at, details, contacts(first_name, last_name, business_name)')
          .gte('created_at', sinceIso)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (afterId) q = q.gt('id', afterId);
        return q as unknown as PromiseLike<{ data: Raw[] | null; error: unknown }>;
      });
      return rows.map((r): ActivityRow => ({
        id: r.id,
        contact_id: r.contact_id,
        contact_name: nameOf(r.contacts),
        action: r.action,
        created_at: r.created_at,
        actor_role: typeof r.details?.actor_role === 'string' ? r.details.actor_role : null,
      }));
    },

    async listViewWindows(sinceIso) {
      const rows = await fetchAllPaged<ViewWindow & { id: string }>((afterId) => {
        let q = server
          .from('impersonation_sessions')
          .select('id, target_contact_id, started_at, ended_at')
          .or(`ended_at.is.null,ended_at.gte."${sinceIso}"`)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (afterId) q = q.gt('id', afterId);
        return q as unknown as PromiseLike<{ data: (ViewWindow & { id: string })[] | null; error: unknown }>;
      });
      return rows;
    },

    // The seam to the messages feature: client-sent messages, counted per contact.
    async countClientMessagesSince(sinceIso) {
      type Raw = { id: string; contact_id: string; contacts: NameParts | null };
      try {
        const rows = await fetchAllPaged<Raw>((afterId) => {
          let q = server
            .from('client_messages')
            .select('id, contact_id, contacts(first_name, last_name, business_name)')
            .eq('sender_role', 'client')
            .gte('created_at', sinceIso)
            .order('id', { ascending: true })
            .limit(PAGE_SIZE);
          if (afterId) q = q.gt('id', afterId);
          return q as unknown as PromiseLike<{ data: Raw[] | null; error: unknown }>;
        });
        const counts = new Map<string, MessageCount>();
        for (const r of rows) {
          const entry = counts.get(r.contact_id) ?? { contact_id: r.contact_id, contact_name: nameOf(r.contacts), count: 0 };
          entry.count += 1;
          counts.set(r.contact_id, entry);
        }
        return [...counts.values()];
      } catch (err) {
        if (isMissingTable((err ?? {}) as { code?: unknown })) return null;
        throw err;
      }
    },

    org: () => org.load(),

    async recipient() {
      const { data: setting } = await server.from('app_settings').select('value').eq('key', 'portal_digest').maybeSingle();
      const override = (setting as { value?: { recipient?: unknown } } | null)?.value?.recipient;
      if (typeof override === 'string' && isValidEmail(override.trim())) return override.trim();
      const { data: profile, error } = await server.from('org_profile').select('owner_user_id').maybeSingle();
      if (error) throw error;
      const ownerId = (profile as { owner_user_id?: string } | null)?.owner_user_id;
      if (!ownerId) return null;
      const { data } = await server.auth.admin.getUserById(ownerId);
      return data?.user?.email ?? null;
    },

    async send(message, identity) {
      const rendered = renderEmail(identity, message.content);
      try {
        const result = await outbound.sendEmail({
          to: message.to,
          subject: message.subject,
          html: rendered.html,
          text: rendered.text,
          fromName: identity.senderName,
          idempotencyKey: message.idempotencyKey,
        });
        return result.status;
      } catch (err) {
        log.error('digest could not be sent', err);
        return 'failed';
      }
    },
  }),
);
