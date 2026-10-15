import { ID } from './ids';
import type { Row } from './postgrest';
import type { CallContext, FnHandler, FnRequest, RpcHandler } from './supabase';

/** Requests (0005): the pick lists, one request out with Ada, and the functions behind them. */

export const REQUEST_ID = '00000000-0000-4000-8000-000000000401';
export const QUESTION_ITEM = '00000000-0000-4000-8000-000000000411';
export const DOCUMENT_ITEM = '00000000-0000-4000-8000-000000000412';

const pick = (rows: [string, string, number, boolean][]) =>
  rows.map(([key, label, sort_order, is_system]) => ({ key, label, colour: null, sort_order, is_active: true, is_system }));

function item(fields: Row): Row {
  return {
    description: null,
    required: true,
    status: 'pending',
    answer_text: null,
    sensitive: false,
    answer_ciphertext: null,
    category: 'general',
    tag: 'general',
    needs_item_documents: [],
    ...fields,
  };
}

export const requestTables: Record<string, Row[]> = {
  request_categories: pick([
    ['general', 'General', 10, true],
    ['contract', 'Contract', 20, false],
    ['invoice', 'Invoice', 30, false],
    ['receipt', 'Receipt', 40, false],
  ]),
  request_tags: pick([
    ['general', 'General', 10, true],
    ['personal', 'Personal', 20, false],
    ['business', 'Business', 30, false],
  ]),
  needs_lists: [
    {
      id: REQUEST_ID,
      contact_id: ID.ada,
      title: 'Onboarding documents',
      status: 'sent',
      intro_message: 'A few things to get started. Thank you!',
      include_contact_confirm: false,
      reminders_paused: false,
      reminder_count: 0,
      last_reminded_at: null,
      created_at: '2026-10-05T15:00:00Z',
      sent_at: '2026-10-05T15:05:00Z',
      submitted_at: null,
      closed_at: null,
      content_version: 1,
      needs_items: [
        item({ id: QUESTION_ITEM, list_id: REQUEST_ID, kind: 'question', label: 'Which day of the month suits a check-in call?', sort_order: 0 }),
        item({ id: DOCUMENT_ITEM, list_id: REQUEST_ID, kind: 'document', label: 'Signed service agreement', sort_order: 1, required: false }),
      ],
    },
  ],
};

function itemsOf(ctx: CallContext): Row[] {
  return ctx.table('needs_lists').flatMap((list) => (list.needs_items as Row[] | undefined) ?? []);
}

export const requestRpc: Record<string, RpcHandler> = {
  /** Creates or replaces a draft with its items, as the owner's one-call save does. */
  needs_owner_save_draft: (args: Record<string, unknown>, ctx: CallContext) => {
    const lists = ctx.table('needs_lists');
    const id = (args.p_list_id as string | null) ?? ctx.newId();
    const items = ((args.p_items as Row[]) ?? []).map((row, i) =>
      item({ ...row, id: ctx.newId(), list_id: id, sort_order: i, description: row.description ?? null }),
    );
    const existing = lists.find((l) => l.id === id);
    const version = existing ? Number(existing.content_version) + 1 : 1;
    const fields = {
      id,
      contact_id: args.p_contact_id,
      title: args.p_title,
      status: 'draft',
      intro_message: args.p_intro ?? null,
      include_contact_confirm: args.p_include_contact_confirm ?? false,
      reminders_paused: false,
      reminder_count: 0,
      last_reminded_at: null,
      created_at: new Date().toISOString(),
      sent_at: null,
      submitted_at: null,
      closed_at: null,
      content_version: version,
      needs_items: items,
    };
    if (existing) Object.assign(existing, fields);
    else lists.push(fields);
    return { id, content_version: version };
  },
};

export const requestFunctions: Record<string, FnHandler> = {
  'send-needs-list': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { list_id: string; remind?: boolean };
    const list = ctx.table('needs_lists').find((l) => l.id === body.list_id);
    if (!list) return { status: 404, json: { error: 'not_found' } };
    if (body.remind) return { json: { status: 'reminded', email_sent: true, remaining: 2 } };
    Object.assign(list, { status: 'sent', sent_at: new Date().toISOString() });
    return { json: { status: 'sent', email_sent: true, start_link: false } };
  },
  /** The client's only write path: answers, task ticks, links and submit. */
  'needs-save': (req: FnRequest, ctx: CallContext) => {
    const body = req.json as { action: string; item_id?: string; answer?: string; list_id?: string };
    if (ctx.principal !== 'client') return { status: 403, json: { error: 'forbidden' } };
    if (body.action === 'save_answer') {
      const target = itemsOf(ctx).find((i) => i.id === body.item_id);
      if (!target) return { status: 404, json: { error: 'not_found' } };
      Object.assign(target, { answer_text: body.answer, status: body.answer?.trim() ? 'fulfilled' : 'pending' });
      return { json: { status: 'saved' } };
    }
    if (body.action === 'submit') {
      const list = ctx.table('needs_lists').find((l) => l.id === body.list_id);
      if (!list) return { status: 404, json: { error: 'not_found' } };
      Object.assign(list, { status: 'submitted', submitted_at: new Date().toISOString() });
      return { json: { status: 'submitted' } };
    }
    return { json: { status: 'saved' } };
  },
};
