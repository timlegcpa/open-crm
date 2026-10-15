import { z } from 'zod';
import type { RequestItem, RequestWithItems } from './lib/requests';

/**
 * A request row with its items, as PostgREST returns them, mapped to the screens' shape.
 * Shared by the owner's api.ts and the portal's portalApi.ts (no supabase-js here).
 * A sensitive answer's ciphertext is read only to know whether one is stored; the bytes
 * are dropped here and never reach a screen.
 */
export const LIST_COLUMNS =
  'id, contact_id, title, status, intro_message, include_contact_confirm, reminders_paused, reminder_count, ' +
  'last_reminded_at, created_at, sent_at, submitted_at, closed_at, content_version';

const documentSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  uploaded_at: z.string(),
  client_documents: z.object({ original_filename: z.string().nullable(), mime_type: z.string().nullable() }).nullable(),
});

const itemSchema = z.object({
  id: z.string(),
  list_id: z.string(),
  kind: z.enum(['document', 'question', 'todo', 'info']),
  label: z.string(),
  description: z.string().nullable(),
  sort_order: z.number(),
  required: z.boolean(),
  status: z.enum(['pending', 'fulfilled', 'reviewed']),
  answer_text: z.string().nullable(),
  sensitive: z.boolean(),
  answer_ciphertext: z.unknown().optional(),
  category: z.string(),
  tag: z.string(),
  needs_item_documents: z.array(documentSchema).nullable().optional(),
});

const listSchema = z.object({
  id: z.string(),
  contact_id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'sent', 'submitted', 'closed']),
  intro_message: z.string().nullable(),
  include_contact_confirm: z.boolean(),
  reminders_paused: z.boolean(),
  reminder_count: z.number(),
  last_reminded_at: z.string().nullable(),
  created_at: z.string(),
  sent_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  content_version: z.number(),
  needs_items: z.array(itemSchema).nullable().optional(),
});

export type RawList = z.input<typeof listSchema>;

function toItem(raw: z.infer<typeof itemSchema>): RequestItem {
  const { answer_ciphertext, needs_item_documents, ...rest } = raw;
  return {
    ...rest,
    has_secret_answer: answer_ciphertext !== null && answer_ciphertext !== undefined && answer_ciphertext !== '' && answer_ciphertext !== '\\x',
    documents: (needs_item_documents ?? [])
      .map((d) => ({
        id: d.id,
        document_id: d.document_id,
        uploaded_at: d.uploaded_at,
        original_filename: d.client_documents?.original_filename ?? null,
        mime_type: d.client_documents?.mime_type ?? null,
      }))
      .sort((a, b) => (a.uploaded_at < b.uploaded_at ? -1 : a.uploaded_at > b.uploaded_at ? 1 : a.id < b.id ? -1 : 1)),
  };
}

export function toRequest(raw: unknown): RequestWithItems {
  const { needs_items, ...list } = listSchema.parse(raw);
  return {
    ...list,
    items: (needs_items ?? []).map(toItem).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)),
  };
}
