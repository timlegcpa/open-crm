/**
 * The client's side of requests. Reads go straight to the tables (RLS shows a client its
 * own lists once sent, never a draft); every write goes through the needs-save edge
 * function, which is the only door for them. Files are uploaded through the documents API
 * into the list's own folder, then linked to their item.
 */
import { z } from 'zod';
import { ensureFolder, uploadDocument } from '@/features/documents/api';
import { invokeEdge } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';
import { requestFolderName, requestFolderPath, type RequestList, type RequestWithItems } from './lib/requests';
import { LIST_COLUMNS, toRequest } from './rows';

export { requestKeys } from './keys';

const ITEMS_SELECT =
  'needs_items(id, list_id, kind, label, description, sort_order, required, status, answer_text, sensitive, answer_ciphertext, category, tag, ' +
  'needs_item_documents(id, document_id, uploaded_at, client_documents(original_filename, mime_type)))';

/** The client's sent, submitted and closed requests (a client has few; capped well past that). */
export async function listMyRequests(contactId: string): Promise<RequestWithItems[]> {
  const { data, error } = await getSupabase()
    .from('needs_lists')
    .select(`${LIST_COLUMNS}, ${ITEMS_SELECT}`)
    .eq('contact_id', contactId)
    .order('sent_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data as unknown[] | null) ?? []).map(toRequest);
}

export async function getMyRequest(id: string): Promise<RequestWithItems | null> {
  const { data, error } = await getSupabase().from('needs_lists').select(`${LIST_COLUMNS}, ${ITEMS_SELECT}`).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toRequest(data) : null;
}

const statusAnswer = z.object({ status: z.string() });
const save = (body: Record<string, unknown>) => invokeEdge('needs-save', body, { parse: (d) => statusAnswer.parse(d).status });

export const saveAnswer = (itemId: string, answer: string) => save({ action: 'save_answer', item_id: itemId, answer });
export const markItem = (itemId: string, done: boolean) => save({ action: 'mark_item', item_id: itemId, done });
export const linkDocument = (itemId: string, documentId: string) => save({ action: 'link_document', item_id: itemId, document_id: documentId });
export const submitRequest = (listId: string) => save({ action: 'submit', list_id: listId });

export const CONFIRM_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'business_name'] as const;
export type ConfirmField = (typeof CONFIRM_FIELDS)[number];
export const saveContactDetails = (listId: string, fields: Partial<Record<ConfirmField, string>>) =>
  save({ action: 'save_contact', list_id: listId, fields });

/**
 * Upload one file to a document item: file it into the list's own folder (made once per
 * list per page), then link it. A file that uploaded but failed to link stays in the
 * folder, where the client and the owner can still see it.
 */
export async function uploadToItem(input: {
  file: File;
  contactId: string;
  list: Pick<RequestList, 'title' | 'sent_at' | 'created_at'>;
  itemId: string;
  category: string;
  ensureListFolder: () => Promise<void>;
}): Promise<string> {
  await input.ensureListFolder();
  const uploaded = await uploadDocument({
    file: input.file,
    contactId: input.contactId,
    folderPath: requestFolderPath(input.list),
    heldBy: 'client',
    category: input.category,
  });
  return linkDocument(input.itemId, uploaded.id);
}

/** Make sure the list's folder exists under the client's section. */
export function ensureRequestFolder(contactId: string, list: Pick<RequestList, 'title' | 'sent_at' | 'created_at'>): Promise<void> {
  return ensureFolder(contactId, requestFolderName(list), '/', 'client');
}

/**
 * Live updates: a request sent, closed or changed refreshes the client's view. Realtime is
 * a nicety; the page still refetches on focus when it cannot start. Each caller gets its
 * own channel, so two subscribers never share (and tear down) one.
 */
export function subscribeToMyRequests(contactId: string, onChange: () => void): () => void {
  const supabase = getSupabase() as unknown as {
    channel?: (name: string) => {
      on: (type: string, filter: Record<string, string>, cb: () => void) => { subscribe: () => unknown };
    };
    removeChannel?: (channel: unknown) => unknown;
  };
  if (typeof supabase.channel !== 'function') return () => {};
  try {
    const channel = supabase
      .channel(`portal-requests-${contactId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'needs_lists', filter: `contact_id=eq.${contactId}` }, onChange)
      .subscribe();
    return () => {
      try {
        supabase.removeChannel?.(channel);
      } catch {
        // Already gone.
      }
    };
  } catch {
    return () => {};
  }
}
