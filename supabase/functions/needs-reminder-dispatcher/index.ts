import { createClient } from '@supabase/supabase-js';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { fetchAllPaged, PAGE_SIZE } from '../_shared/paging.ts';
import { LIST_COLUMNS, createNeedsSendStore } from '../send-needs-list/store.ts';
import { createDispatcherHandler, type DispatchListRow } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });

/** PostgREST puts an `in` list in the URL; keep each one well under its length limit. */
const ID_CHUNK = 200;

Deno.serve(
  createDispatcherHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,
    cronSecret: Deno.env.get('CRON_SHARED_SECRET'),
    authorizeOwner: (token) => authorizeOwner(clients, token),

    async loadSettings() {
      const { data, error } = await server.from('app_settings').select('value').eq('key', 'needs_reminders').maybeSingle();
      if (error) throw error;
      return (data as { value?: unknown } | null)?.value ?? null;
    },

    sentLists: () =>
      fetchAllPaged<DispatchListRow>((afterId) => {
        let q = server
          .from('needs_lists')
          .select(`${LIST_COLUMNS}, reminders_paused, sent_at, last_reminded_at`)
          .eq('status', 'sent')
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (afterId) q = q.gt('id', afterId);
        return q;
      }),

    async activeContacts(contactIds) {
      const out = new Set<string>();
      for (let i = 0; i < contactIds.length; i += ID_CHUNK) {
        const { data, error } = await server
          .from('client_portal_accounts')
          .select('contact_id')
          .in('contact_id', contactIds.slice(i, i + ID_CHUNK))
          .eq('status', 'active')
          .not('user_id', 'is', null);
        if (error) throw error;
        for (const row of (data as { contact_id: string }[] | null) ?? []) out.add(row.contact_id);
      }
      return out;
    },

    async archivedContacts(contactIds) {
      const out = new Set<string>();
      for (let i = 0; i < contactIds.length; i += ID_CHUNK) {
        const { data, error } = await server
          .from('contacts')
          .select('id')
          .in('id', contactIds.slice(i, i + ID_CHUNK))
          .not('archived_at', 'is', null);
        if (error) throw error;
        for (const row of (data as { id: string }[] | null) ?? []) out.add(row.id);
      }
      return out;
    },

    store: createNeedsSendStore({ server, org, outbound }),
  }),
);
