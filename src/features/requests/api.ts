/**
 * The owner's side of requests: reads and writes under RLS (0005), and the edge functions
 * that send, remind and reveal. Portal code never imports this module (portalApi.ts is
 * the client's).
 *
 * The builder saves a draft in one call (needs_owner_save_draft): the list's fields and
 * every item in one transaction, only while it is a draft and still at the version the
 * builder read, so a save that lands after a send or another edit fails instead of
 * rewriting what the client is answering. Sending goes through send-needs-list, which
 * publishes only the version it read.
 *
 * NEVER delete a documents-bucket object from here (see documents/api.ts): deleting a
 * request removes document ROWS at most, through the documents API.
 */
import { z } from 'zod';
import { definePickList } from '@/api/pickLists';
import { deleteDocument, removeFolder, writeAudit } from '@/features/documents/api';
import { invokeEdge } from '@/lib/edge';
import { fetchAllPaged, PAGE_SIZE, type PageResult } from '@/lib/pagedFetch';
import { getSupabase } from '@/lib/supabase';
import {
  itemRow,
  normalizeReminderSettings,
  REMINDER_SETTINGS_KEY,
  requestFolderName,
  type DraftItem,
  type ReminderSettings,
  type RequestList,
  type RequestWithItems,
} from './lib/requests';
import { LIST_COLUMNS, toRequest, type RawList } from './rows';

export { requestKeys } from './keys';

/** The request pick-lists, owner-editable (Settings, Requests). */
export interface RequestPickRow {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}
export const REQUEST_CATEGORIES = definePickList<RequestPickRow>('request_categories', 'key, label, colour, sort_order, is_active, is_system');
export const REQUEST_TAGS = definePickList<RequestPickRow>('request_tags', 'key, label, colour, sort_order, is_active, is_system');

const ITEMS_SELECT =
  'needs_items(id, list_id, kind, label, description, sort_order, required, status, answer_text, sensitive, answer_ciphertext, category, tag, ' +
  'needs_item_documents(id, document_id, uploaded_at, client_documents(original_filename, mime_type)))';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface ListQuery {
  eq(column: string, value: unknown): ListQuery;
  gt(column: string, value: unknown): ListQuery;
  order(column: string, options?: { ascending?: boolean }): ListQuery;
  limit(n: number): PromiseLike<PageResult<never>>;
}

/** Every request with its items, of one contact or of all; read in pages by id. */
export async function listRequests(contactId?: string): Promise<RequestWithItems[]> {
  const rows = await fetchAllPaged<RawList>((afterId) => {
    let query = getSupabase().from('needs_lists').select(`${LIST_COLUMNS}, ${ITEMS_SELECT}`) as unknown as ListQuery;
    if (contactId) query = query.eq('contact_id', contactId);
    if (afterId) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(PAGE_SIZE) as PromiseLike<PageResult<RawList>>;
  });
  return rows.map(toRequest);
}

export async function getRequest(id: string): Promise<RequestWithItems | null> {
  const { data, error } = await getSupabase().from('needs_lists').select(`${LIST_COLUMNS}, ${ITEMS_SELECT}`).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toRequest(data as unknown as RawList) : null;
}

/** Answered items on open lists, waiting for the owner's accept: the nav and tab badges. */
export async function countAwaitingAccept(contactId?: string): Promise<number> {
  let query = getSupabase()
    .from('needs_items')
    .select('id, needs_lists!inner(contact_id, status)', { count: 'exact', head: true })
    .eq('status', 'fulfilled')
    .in('needs_lists.status', ['sent', 'submitted']);
  if (contactId) query = query.eq('needs_lists.contact_id', contactId);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** The contact's drafts, for the "already has a draft" warning. */
export async function listDraftIds(contactId: string): Promise<string[]> {
  const { data, error } = await getSupabase().from('needs_lists').select('id').eq('contact_id', contactId).eq('status', 'draft').limit(50);
  if (error) throw error;
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface DraftInput {
  title: string;
  intro: string;
  includeContactConfirm: boolean;
  items: DraftItem[];
}

export class NotADraftError extends Error {
  constructor() {
    super('This request was sent meanwhile, so it can no longer be edited. Refresh to see it.');
    this.name = 'NotADraftError';
  }
}

export class DraftChangedError extends Error {
  constructor() {
    super('This draft was changed somewhere else meanwhile, so it was not saved. Refresh to see the latest version.');
    this.name = 'DraftChangedError';
  }
}

const savedDraft = z.object({ id: z.string(), content_version: z.number() });

/**
 * Create a draft (no `draft`) or replace one at the version the builder read: the list's
 * fields and every item, in one transaction (needs_owner_save_draft). A failure leaves
 * the old draft as it was.
 */
async function saveDraft(
  contactId: string,
  input: DraftInput,
  draft: { id: string; contentVersion: number } | null,
): Promise<z.infer<typeof savedDraft>> {
  const { data, error } = await getSupabase().rpc('needs_owner_save_draft', {
    p_list_id: draft?.id ?? null,
    p_contact_id: contactId,
    p_expected_version: draft?.contentVersion ?? null,
    p_title: input.title.trim(),
    p_intro: input.intro.trim() || null,
    p_include_contact_confirm: input.includeContactConfirm,
    p_items: input.items.map((item, i) => itemRow(item, i)),
  });
  if (error) {
    if (/not_draft/.test(error.message)) throw new NotADraftError();
    if (/stale_content/.test(error.message)) throw new DraftChangedError();
    throw error;
  }
  return savedDraft.parse(data);
}

/** A new draft with its items, in one call. Returns its id. */
export async function createDraft(contactId: string, input: DraftInput): Promise<string> {
  return (await saveDraft(contactId, input, null)).id;
}

/** Replace a draft's content at the version read. Refused once the list is sent, or when it changed meanwhile. */
export async function updateDraft(
  draft: { id: string; contactId: string; contentVersion: number },
  input: DraftInput,
): Promise<void> {
  await saveDraft(draft.contactId, input, { id: draft.id, contentVersion: draft.contentVersion });
}

// ---------------------------------------------------------------------------
// Sending and the owner's actions on a sent list
// ---------------------------------------------------------------------------

const sendAnswer = z.object({ status: z.literal('sent'), email_sent: z.boolean().nullable(), start_link: z.boolean() });
const remindAnswer = z.object({ status: z.literal('reminded'), email_sent: z.boolean().nullable(), remaining: z.number() });

export function sendRequest(id: string) {
  return invokeEdge('send-needs-list', { list_id: id }, { parse: (d) => sendAnswer.parse(d) });
}

export function remindRequest(id: string) {
  return invokeEdge('send-needs-list', { list_id: id, remind: true }, { parse: (d) => remindAnswer.parse(d) });
}

export async function setRemindersPaused(id: string, paused: boolean): Promise<void> {
  const { data, error } = await getSupabase().from('needs_lists').update({ reminders_paused: paused }).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('The request was not changed. Refresh and try again.');
}

export class AnswerChangedError extends Error {
  constructor() {
    super('The answer changed while you were looking. Refresh to see it.');
    this.name = 'AnswerChangedError';
  }
}

/** Accept one answered item. Only an item still answered is accepted (the client may have cleared it). */
export async function acceptItem(itemId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from('needs_items')
    .update({ status: 'reviewed' })
    .eq('id', itemId)
    .eq('status', 'fulfilled')
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new AnswerChangedError();
}

/** Accept every answered item of a list; how many were accepted. */
export async function acceptAll(listId: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from('needs_items')
    .update({ status: 'reviewed' })
    .eq('list_id', listId)
    .eq('status', 'fulfilled')
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

/** Close a sent or submitted list: the client sees it as closed and can change nothing more. */
export async function closeRequest(id: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from('needs_lists')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['sent', 'submitted'])
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Only a sent request can be closed. Refresh and try again.');
}

const revealAnswerSchema = z.object({ value: z.string() });

/** A sensitive answer, decrypted on the server; every call is audited there. */
export async function revealAnswer(itemId: string): Promise<string> {
  return (await invokeEdge('needs-reveal-answer', { item_id: itemId }, { parse: (d) => revealAnswerSchema.parse(d) })).value;
}

export interface DeleteResult {
  documentsDeleted: number;
  /** False when a file or folder step failed; the request itself is gone either way. */
  cleanupOk: boolean;
}

/**
 * Delete a request, at any status. The list row goes first (its items, answers and links
 * cascade, so the client's answers are gone even if what follows fails). With
 * `deleteFiles`, the documents uploaded to it are then removed as ROWS through the
 * documents API, and the list's upload folder is removed (anything else in it moves to the
 * section's root). Storage objects are never touched.
 */
export async function deleteRequest(list: Pick<RequestList, 'id' | 'contact_id' | 'title' | 'sent_at' | 'created_at'>, opts: { deleteFiles: boolean }): Promise<DeleteResult> {
  const supabase = getSupabase();
  // The links, read BEFORE the cascade removes them. One document linked twice counts once.
  const { data: links, error: linksError } = await supabase
    .from('needs_item_documents')
    .select('document_id, needs_items!inner(list_id)')
    .eq('needs_items.list_id', list.id);
  if (linksError) throw linksError;
  const documentIds = [...new Set(((links as { document_id: string }[] | null) ?? []).map((l) => l.document_id))];

  const { data: deleted, error } = await supabase.from('needs_lists').delete().eq('id', list.id).select('id');
  if (error) throw error;
  if (!deleted || deleted.length === 0) throw new Error('The request was not deleted. It may already be gone.');

  let cleanupOk = true;
  let documentsDeleted = 0;
  if (opts.deleteFiles) {
    for (const documentId of documentIds) {
      try {
        await deleteDocument(documentId, 'owner');
        documentsDeleted++;
      } catch {
        cleanupOk = false;
      }
    }
    if (list.sent_at) {
      try {
        const { data: folders, error: folderError } = await supabase
          .from('client_folders')
          .select('id')
          .eq('contact_id', list.contact_id)
          .eq('parent_path', '/')
          .eq('held_by', 'client')
          .eq('name', requestFolderName(list));
        if (folderError) throw folderError;
        for (const folder of (folders as { id: string }[] | null) ?? []) await removeFolder(folder.id);
      } catch {
        cleanupOk = false;
      }
    }
  }
  await writeAudit('needs_list_deleted', {
    list_id: list.id,
    contact_id: list.contact_id,
    documents_deleted: documentsDeleted,
    cleanup_ok: cleanupOk,
    source: 'owner',
  });
  return { documentsDeleted, cleanupOk };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  intro_message: z.string().nullable(),
  include_contact_confirm: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())),
  updated_at: z.string(),
});
export type RequestTemplate = z.infer<typeof templateSchema>;

export async function listTemplates(): Promise<RequestTemplate[]> {
  const rows = await fetchAllPaged<RequestTemplate>((afterId) => {
    let query = getSupabase().from('needs_templates').select('id, name, intro_message, include_contact_confirm, items, updated_at') as unknown as ListQuery;
    if (afterId) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(PAGE_SIZE) as PromiseLike<PageResult<RequestTemplate>>;
  });
  return z.array(templateSchema).parse(rows).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
}

export async function saveTemplate(name: string, input: DraftInput): Promise<void> {
  const items = input.items.map((item) => {
    const row = itemRow(item, 0);
    return { kind: row.kind, label: row.label, description: row.description, required: row.required, sensitive: row.sensitive, category: row.category, tag: row.tag };
  });
  const { error } = await getSupabase().from('needs_templates').insert({
    name: name.trim(),
    intro_message: input.intro.trim() || null,
    include_contact_confirm: input.includeContactConfirm,
    items,
  });
  if (error) throw error;
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await getSupabase().from('needs_templates').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reminder settings
// ---------------------------------------------------------------------------

export async function getReminderSettings(): Promise<ReminderSettings> {
  const { data, error } = await getSupabase().from('app_settings').select('value').eq('key', REMINDER_SETTINGS_KEY).maybeSingle();
  if (error) throw error;
  return normalizeReminderSettings((data as { value?: unknown } | null)?.value ?? null);
}

export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  const value = normalizeReminderSettings(settings);
  const { error } = await getSupabase().from('app_settings').upsert({ key: REMINDER_SETTINGS_KEY, value }, { onConflict: 'key' });
  if (error) throw error;
}
