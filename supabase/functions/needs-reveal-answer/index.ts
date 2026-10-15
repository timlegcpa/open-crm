import { createClient } from '@supabase/supabase-js';
import { createAudit } from '../_shared/audit.ts';
import { authorizeOwner, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { createRevealAnswerHandler } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const auditLog = createAudit({ db: server });

Deno.serve(
  createRevealAnswerHandler({
    allowedOrigins: config.allowedOrigins,
    authorizeOwner: (token) => authorizeOwner(clients, token),
    piiKey: Deno.env.get('PII_ENCRYPTION_KEY')?.trim() || null,

    async loadItem(itemId) {
      const { data, error } = await server
        .from('needs_items')
        .select('id, list_id, sensitive, answer_ciphertext, needs_lists!inner(contact_id)')
        .eq('id', itemId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as unknown as {
        id: string; list_id: string; sensitive: boolean; answer_ciphertext: unknown; needs_lists: { contact_id: string };
      };
      return { id: row.id, list_id: row.list_id, sensitive: row.sensitive, answer_ciphertext: row.answer_ciphertext, contact_id: row.needs_lists.contact_id };
    },

    audit: (entry) => auditLog.write(entry),
  }),
);
