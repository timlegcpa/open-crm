import { createClient } from '@supabase/supabase-js';
import { authorizeClient, supabaseClients } from '../_shared/auth.ts';
import { loadConfig } from '../_shared/config.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { createOrgLoader } from '../_shared/organization.ts';
import { createOutbound, readOutboundEnv } from '../_shared/outbound.ts';
import { loadOwnerEmail } from '../_shared/owner.ts';
import { createNeedsSaveHandler, type ClientItemRow, type ClientListRow, type NeedsContactNames, type SubmitOutcome } from './handler.ts';

const config = loadConfig((name) => Deno.env.get(name));
const clients = supabaseClients(createClient, config);
const server = clients.service;
const org = createOrgLoader({ db: server, supabaseUrl: config.supabaseUrl });
const outbound = createOutbound({ env: readOutboundEnv((name) => Deno.env.get(name)), db: server });

/** The ids of this contact's non-draft lists, the scope every read below stays inside. */
async function ownList(contactId: string, listId: string): Promise<ClientListRow | null> {
  const { data, error } = await server
    .from('needs_lists')
    .select('id, title, status, include_contact_confirm')
    .eq('id', listId)
    .eq('contact_id', contactId)
    .neq('status', 'draft')
    .maybeSingle();
  if (error) throw error;
  return (data as ClientListRow | null) ?? null;
}

Deno.serve(
  createNeedsSaveHandler({
    allowedOrigins: config.allowedOrigins,
    siteUrl: config.siteUrl,
    authorizeClient: (token) => authorizeClient(clients, token),
    piiKey: Deno.env.get('PII_ENCRYPTION_KEY')?.trim() || null,

    async loadItem(contactId, itemId) {
      const { data, error } = await server.from('needs_items').select('id, list_id, kind, sensitive').eq('id', itemId).maybeSingle();
      if (error) throw error;
      const item = data as ClientItemRow | null;
      if (!item || !(await ownList(contactId, item.list_id))) return null;
      return item;
    },

    loadList: ownList,

    async updateContact(contactId, fields) {
      const { error } = await server.from('contacts').update(fields).eq('id', contactId);
      if (error) throw error;
    },

    async setAnswer(contactId, itemId, text, ciphertextHex) {
      const { data, error } = await server.rpc('needs_client_set_answer', {
        p_contact_id: contactId, p_item_id: itemId, p_answer_text: text, p_answer_ciphertext: ciphertextHex,
      });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async markTodo(contactId, itemId, done) {
      const { data, error } = await server.rpc('needs_client_mark_todo', { p_contact_id: contactId, p_item_id: itemId, p_done: done });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async linkDocument(contactId, itemId, documentId) {
      const { data, error } = await server.rpc('needs_client_link_document', {
        p_contact_id: contactId, p_item_id: itemId, p_document_id: documentId,
      });
      if (error) throw error;
      return data === 'linked' || data === 'already_linked' ? data : null;
    },

    async submit(contactId, listId) {
      const { data, error } = await server.rpc('needs_client_submit', { p_contact_id: contactId, p_list_id: listId });
      if (error) throw error;
      return data as SubmitOutcome;
    },

    async progress(listId) {
      const { data, error } = await server.rpc('needs_list_progress', { p_list_ids: [listId] });
      if (error) throw error;
      const row = ((data as { actionable: number; fulfilled: number; required_open: number }[] | null) ?? [])[0];
      return row ?? { actionable: 0, fulfilled: 0, required_open: 0 };
    },

    async documentProgress(listId) {
      const { data, error } = await server.from('needs_items').select('id, needs_item_documents(id)').eq('list_id', listId).eq('kind', 'document');
      if (error) throw error;
      const rows = (data as { needs_item_documents: unknown[] | null }[] | null) ?? [];
      return { filesAsked: rows.length, filesIn: rows.filter((r) => (r.needs_item_documents ?? []).length > 0).length };
    },

    async claimUploadNotice(listId) {
      const { data, error } = await server.rpc('needs_claim_upload_notice', { p_list_id: listId });
      if (error) throw error;
      return typeof data === 'string' ? data : null;
    },

    async releaseUploadNotice(listId, stamp) {
      const { error } = await server.rpc('needs_release_upload_notice', { p_list_id: listId, p_stamp: stamp });
      if (error) throw error;
    },

    async loadContact(contactId) {
      const { data, error } = await server.from('contacts').select('first_name, last_name, business_name, email').eq('id', contactId).maybeSingle();
      if (error) throw error;
      return (data as NeedsContactNames | null) ?? null;
    },

    ownerEmail: () => loadOwnerEmail(server),
    loadOrg: () => org.load(),

    async sendEmail({ to, subject, content, fromName, idempotencyKey }) {
      const message = renderEmail(await org.load(), content);
      return outbound.sendEmail({ to, subject, html: message.html, text: message.text, fromName, idempotencyKey });
    },

    async logActivity({ contactId, userId, action, details, ip, userAgent }) {
      const { error } = await server.from('client_activity_log').insert({
        contact_id: contactId,
        user_id: userId,
        action,
        details,
        ip_address: ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null,
      });
      if (error) throw error;
    },
  }),
);
