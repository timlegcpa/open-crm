// The portal's deletes remove ROWS and never a STORAGE OBJECT.
//
// One object can back more than one row: "copy to shared" inserts a second row over the
// same object, and a signed document is filed to every signer over one object. Deleting
// the object on the first row's delete would strand the others, and a "is anything still
// pointing at it?" check cannot save it: Storage is not transactional with Postgres, so a
// concurrent copy can add a reference between the check and the delete. A row delete
// leaves the object behind, which is the accepted state (the orphan report lists it).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = [method: string, args: unknown[]];

const state = vi.hoisted(() => ({
  tables: [] as Array<{ table: string; calls: Call[] }>,
  results: {} as Record<string, unknown>,
  rpc: vi.fn(),
  storageFrom: vi.fn(),
  insertFails: false,
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const entry = { table, calls: [] as Call[] };
    state.tables.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'delete', 'insert', 'order', 'limit', 'gt']) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, args]);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const isInsert = entry.calls.some(([m]) => m === 'insert');
      if (isInsert && state.insertFails) return Promise.reject(new Error('activity insert refused')).then(resolve, reject);
      return Promise.resolve(state.results[table] ?? { data: null, error: null }).then(resolve, reject);
    };
    return b;
  }
  return {
    getSupabase: () => ({
      from: (table: string) => builder(table),
      rpc: (...args: unknown[]) => state.rpc(...args),
      storage: { from: (...args: unknown[]) => state.storageFrom(...args) },
      auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'user-ada' } } } }) },
    }),
  };
});

import { deleteDocument, purgeFolder } from '../api';

const ROW = { id: 'doc-1', contact_id: 'contact-ada', original_filename: 'Acme LLC invoice.pdf' };

beforeEach(() => {
  state.tables = [];
  state.results = {};
  state.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  state.storageFrom.mockReset();
  state.insertFails = false;
});

const callsOn = (table: string) => state.tables.filter((t) => t.table === table).map((t) => t.calls);

describe('deleteDocument from the portal', () => {
  it('deletes the row by id and asks for the deleted row back as proof', async () => {
    state.results.client_documents = { data: [ROW], error: null };
    await deleteDocument('doc-1', 'client');
    const [calls] = callsOn('client_documents');
    expect(calls.map(([m]) => m)).toEqual(['delete', 'eq', 'select']);
    expect(calls[1]).toEqual(['eq', ['id', 'doc-1']]);
  });

  it('NEVER touches the storage bucket', async () => {
    state.results.client_documents = { data: [ROW], error: null };
    await deleteDocument('doc-1', 'client');
    expect(state.storageFrom).not.toHaveBeenCalled();
  });

  it('takes no storage path, so no caller can hand it an object to destroy', () => {
    // (id, actor): the signature is the guarantee.
    expect(deleteDocument.length).toBe(2);
  });

  it('throws when RLS refused the delete (no row came back), rather than reporting success', async () => {
    state.results.client_documents = { data: [], error: null };
    await expect(deleteDocument('doc-1', 'client')).rejects.toThrow(/not deleted/);
    expect(callsOn('client_activity_log')).toHaveLength(0);
    expect(state.storageFrom).not.toHaveBeenCalled();
  });

  it("records the client's document_delete with only the keys its insert policy allows", async () => {
    state.results.client_documents = { data: [ROW], error: null };
    await deleteDocument('doc-1', 'client');
    const [calls] = callsOn('client_activity_log');
    expect(calls).toEqual([
      ['insert', [{
        contact_id: 'contact-ada',
        user_id: 'user-ada',
        action: 'document_delete',
        details: { document_id: 'doc-1', filename: 'Acme LLC invoice.pdf' },
      }]],
    ]);
    expect(callsOn('audit_logs')).toHaveLength(0);
  });

  it('a failed activity row does not report the delete as failed', async () => {
    state.results.client_documents = { data: [ROW], error: null };
    state.insertFails = true;
    await expect(deleteDocument('doc-1', 'client')).resolves.toBeUndefined();
  });
});

describe('purgeFolder from the portal', () => {
  it('is one database call, and never touches the storage bucket', async () => {
    await purgeFolder('folder-1');
    expect(state.rpc).toHaveBeenCalledWith('portal_folder_purge', { p_folder_id: 'folder-1' });
    expect(state.storageFrom).not.toHaveBeenCalled();
    expect(state.tables).toHaveLength(0);
  });

  it('passes a refusal through', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: 'Folder not found', code: 'P0002' } });
    await expect(purgeFolder('folder-1')).rejects.toMatchObject({ code: 'P0002' });
  });
});
