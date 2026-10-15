// The send and remind paths' database and mail, over supabase-js as the server. Shared by
// send-needs-list and needs-reminder-dispatcher, so both read and count the same way.

import type { SupabaseClient } from '@supabase/supabase-js';
import { renderEmail } from '../_shared/email-layout.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import type { EmailMessage, SendResult } from '../_shared/outbound.ts';
import type { ListProgress, NeedsContactRow, NeedsListRow, NeedsSendStore, RecipientCheck, SendOutcome } from './handler.ts';

export const LIST_COLUMNS = 'id, contact_id, title, intro_message, status, content_version, reminder_count';

export function createNeedsSendStore(deps: {
  server: SupabaseClient;
  org: { load(): Promise<OrgIdentity> };
  outbound: { sendEmail(message: EmailMessage): Promise<SendResult> };
}): NeedsSendStore {
  const { server } = deps;
  return {
    async loadList(listId) {
      const { data, error } = await server.from('needs_lists').select(LIST_COLUMNS).eq('id', listId).maybeSingle();
      if (error) throw error;
      return (data as NeedsListRow | null) ?? null;
    },

    async loadContact(contactId) {
      const { data, error } = await server.from('contacts').select('first_name, email').eq('id', contactId).maybeSingle();
      if (error) throw error;
      return (data as NeedsContactRow | null) ?? null;
    },

    async countItems(listId) {
      const { count, error } = await server.from('needs_items').select('id', { count: 'exact', head: true }).eq('list_id', listId);
      if (error) throw error;
      return count ?? 0;
    },

    async progress(listId) {
      const { data, error } = await server.rpc('needs_list_progress', { p_list_ids: [listId] });
      if (error) throw error;
      const row = ((data as ListProgress[] | null) ?? [])[0];
      return row ?? { actionable: 0, fulfilled: 0, required_open: 0 };
    },

    async hasActivePortalAccount(contactId) {
      const { count, error } = await server
        .from('client_portal_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .eq('status', 'active')
        .not('user_id', 'is', null);
      if (error) throw error;
      return (count ?? 0) > 0;
    },

    async issueStartLink({ listId, contactId, email, tokenHash, expiresAt, actorId }) {
      const { data, error } = await server.rpc('needs_issue_start_link', {
        p_list_id: listId,
        p_contact_id: contactId,
        p_email: email,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt.toISOString(),
        p_actor: actorId,
      });
      if (error) {
        if (error.message === 'contact_changed' || error.message === 'address_changed') return { refused: error.message };
        throw error;
      }
      return { id: data as string };
    },

    async expireStartLink(linkId) {
      const { error } = await server.rpc('expire_start_link', { p_id: linkId });
      if (error) throw error;
    },

    async supersedeStartLinks(listId, keepLinkId) {
      const { error } = await server.rpc('needs_supersede_start_links', { p_list_id: listId, p_keep: keepLinkId });
      if (error) throw error;
    },

    async sendList(listId, expectedVersion, { contactId, email }) {
      const { data, error } = await server.rpc('needs_send_list', {
        p_list_id: listId,
        p_expected_version: expectedVersion,
        p_contact_id: contactId,
        p_email: email,
      });
      if (error) throw error;
      return data as SendOutcome;
    },

    async recipientCurrent(listId, { contactId, email }) {
      const { data, error } = await server.rpc('needs_recipient_current', { p_list_id: listId, p_contact_id: contactId, p_email: email });
      if (error) throw error;
      return data as RecipientCheck;
    },

    async claimReminder(listId, expectedCount) {
      const { data, error } = await server.rpc('needs_claim_reminder', { p_list_id: listId, p_expected_count: expectedCount });
      if (error) throw error;
      return data as 'claimed' | 'in_progress' | 'not_sent';
    },

    async releaseReminder(listId, claimedCount) {
      const { error } = await server.rpc('needs_release_reminder', { p_list_id: listId, p_claimed_count: claimedCount });
      if (error) throw error;
    },

    loadOrg: () => deps.org.load(),

    async sendEmail({ to, subject, content, fromName, idempotencyKey }) {
      const identity = await deps.org.load();
      const message = renderEmail(identity, content);
      return deps.outbound.sendEmail({ to, subject, html: message.html, text: message.text, fromName, idempotencyKey });
    },
  };
}
