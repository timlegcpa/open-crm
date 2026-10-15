// @vitest-environment node
// The owner's request writes, against a recording client: what each call asks the
// database for, how a zero-row answer is reported, and that deleting a request never
// reaches Storage (a client document object is never deleted automatically).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: unknown; count?: number | null };
interface Recorded {
  table: string;
  chain: Array<[string, unknown[]]>;
}

const h = vi.hoisted(() => ({
  calls: [] as Recorded[],
  storageTouched: 0,
  answer: (() => ({ data: [], error: null })) as (call: Recorded) => Result,
  invoked: [] as Array<{ name: string; body: unknown }>,
  rpcAnswer: null as Result | null,
  rpcAnswers: {} as Record<string, Result>,
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const call: Recorded = { table, chain: [] };
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            h.calls.push(call);
            const result = h.answer(call);
            return (ok: (v: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
          }
          return (...args: unknown[]) => {
            call.chain.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args?: unknown) => {
      h.calls.push({ table: `rpc:${name}`, chain: [['args', [args]]] });
      return h.rpcAnswers[name] ?? h.rpcAnswer ?? { data: { folders_deleted: 1, documents_moved: 0 }, error: null };
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: '00000000-0000-4000-8000-000000000001' } } } }) },
    get storage() {
      h.storageTouched++;
      return { from: () => ({ remove: async () => ({ data: null, error: null }) }) };
    },
  };
  return { getSupabase: () => client };
});
vi.mock('@/lib/edge', () => ({
  invokeEdge: async (name: string, body: unknown, options: { parse?: (v: unknown) => unknown } = {}) => {
    h.invoked.push({ name, body });
    const answer = name === 'send-needs-list' ? { status: 'sent', email_sent: true, start_link: false } : { value: 'x' };
    return options.parse ? options.parse(answer) : answer;
  },
}));

import {
  acceptItem,
  AnswerChangedError,
  closeRequest,
  countAwaitingAccept,
  createDraft,
  deleteRequest,
  DraftChangedError,
  NotADraftError,
  sendRequest,
  updateDraft,
} from '../api';
import { newDraftItem } from '../lib/requests';

const LIST = { id: 'list-1', contact_id: 'contact-1', title: 'Onboarding', sent_at: '2026-06-19T12:00:00Z', created_at: '2026-06-01T00:00:00Z' };
const has = (call: Recorded, method: string, ...args: unknown[]) =>
  call.chain.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));

beforeEach(() => {
  h.calls = [];
  h.storageTouched = 0;
  h.invoked = [];
  h.answer = () => ({ data: [], error: null });
  h.rpcAnswer = null;
  h.rpcAnswers = {};
});

describe('deleting a request', () => {
  it('deletes through the one audited call, then the linked document rows and the list folder, and never touches Storage', async () => {
    h.rpcAnswers.needs_owner_delete_list = { data: ['doc-1', 'doc-2'], error: null };
    h.answer = (call) => {
      if (call.table === 'client_documents') return { data: [{ id: 'doc', contact_id: 'contact-1', original_filename: 'a.pdf' }], error: null };
      if (call.table === 'client_folders') return { data: [{ id: 'folder-1' }], error: null };
      return { data: null, error: null };
    };
    const result = await deleteRequest(LIST, { deleteFiles: true });
    expect(result).toEqual({ documentsDeleted: 2, cleanupOk: true });
    const del = h.calls.find((c) => c.table === 'rpc:needs_owner_delete_list')!;
    expect(del.chain[0][1][0]).toEqual({ p_list_id: LIST.id });
    // Never a bare table delete of the list.
    expect(h.calls.some((c) => c.table === 'needs_lists' || c.table === 'needs_items' || c.table === 'needs_item_documents')).toBe(false);
    expect(h.calls.filter((c) => c.table === 'client_documents')).toHaveLength(2);
    const folder = h.calls.find((c) => c.table === 'client_folders')!;
    expect(has(folder, 'eq', 'name', 'Onboarding – 2026-06-19')).toBe(true);
    expect(has(folder, 'eq', 'held_by', 'client')).toBe(true);
    expect(h.calls.some((c) => c.table === 'rpc:admin_client_folder_remove')).toBe(true);
    const audit = h.calls.find((c) => c.table === 'audit_logs' && (c.chain[0][1][0] as { action?: string }).action === 'needs_list_files_deleted')!;
    expect(audit.chain[0][1][0]).toMatchObject({ action: 'needs_list_files_deleted', details: { list_id: LIST.id, documents_deleted: 2, cleanup_ok: true } });
    expect(h.storageTouched).toBe(0);
  });

  it('keeps the files when asked, and says when nothing was deleted', async () => {
    h.rpcAnswers.needs_owner_delete_list = { data: ['doc-1'], error: null };
    await deleteRequest(LIST, { deleteFiles: false });
    expect(h.calls.some((c) => c.table === 'client_documents' || c.table === 'client_folders' || c.table === 'audit_logs')).toBe(false);
    h.rpcAnswers.needs_owner_delete_list = { data: null, error: { message: 'not_found' } };
    await expect(deleteRequest(LIST, { deleteFiles: true })).rejects.toThrow(/not deleted/);
    expect(h.storageTouched).toBe(0);
  });
});

describe('the owner’s guarded writes', () => {
  it('accepts only an item still answered, and says so when it is not', async () => {
    await expect(acceptItem('item-1')).rejects.toBeInstanceOf(AnswerChangedError);
    const call = h.calls[0];
    expect(has(call, 'update', { status: 'reviewed' })).toBe(true);
    expect(has(call, 'eq', 'status', 'fulfilled')).toBe(true);
  });

  it('saves a draft in one call, at the version read, and never writes the tables itself', async () => {
    const input = { title: ' T ', intro: '', includeContactConfirm: true, items: [{ ...newDraftItem('todo'), label: 'Sign' }] };
    h.rpcAnswer = { data: { id: 'list-1', content_version: 4 }, error: null };
    await updateDraft({ id: 'list-1', contactId: 'contact-1', contentVersion: 3 }, input);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].table).toBe('rpc:needs_owner_save_draft');
    expect(h.calls[0].chain[0][1][0]).toEqual({
      p_list_id: 'list-1', p_contact_id: 'contact-1', p_expected_version: 3, p_title: 'T', p_intro: null,
      p_include_contact_confirm: true,
      p_items: [{ kind: 'todo', label: 'Sign', description: null, required: true, sensitive: false, category: 'general', tag: 'general', sort_order: 0 }],
    });
    h.calls = [];
    expect(await createDraft('contact-1', input)).toBe('list-1');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].chain[0][1][0]).toMatchObject({ p_list_id: null, p_expected_version: null });
  });

  it('says why a draft save was refused', async () => {
    const input = { title: 'T', intro: '', includeContactConfirm: false, items: [] };
    const target = { id: 'list-1', contactId: 'contact-1', contentVersion: 3 };
    h.rpcAnswer = { data: null, error: { message: 'not_draft' } };
    await expect(updateDraft(target, input)).rejects.toBeInstanceOf(NotADraftError);
    h.rpcAnswer = { data: null, error: { message: 'stale_content' } };
    await expect(updateDraft(target, input)).rejects.toBeInstanceOf(DraftChangedError);
  });

  it('closes only a sent or submitted request', async () => {
    await expect(closeRequest('list-1')).rejects.toThrow(/Only a sent request/);
    expect(has(h.calls[0], 'in', 'status', ['sent', 'submitted'])).toBe(true);
  });

  it('counts answered items on open lists for the badges', async () => {
    h.answer = () => ({ data: null, error: null, count: 3 });
    expect(await countAwaitingAccept('contact-1')).toBe(3);
    const call = h.calls[0];
    expect(has(call, 'eq', 'status', 'fulfilled')).toBe(true);
    expect(has(call, 'in', 'needs_lists.status', ['sent', 'submitted'])).toBe(true);
    expect(has(call, 'eq', 'needs_lists.contact_id', 'contact-1')).toBe(true);
  });

  it('sends through send-needs-list with the list id only', async () => {
    await sendRequest('list-1');
    expect(h.invoked).toEqual([{ name: 'send-needs-list', body: { list_id: 'list-1' } }]);
  });
});
