// The owner-side reads and writes: explicit columns, keyset paging, the order of a
// document delete, the two-bucket signed copy, the settings write.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeError } from '@/lib/edgeCore';

type Call = [method: string, args: unknown[]];
interface Result {
  data: unknown;
  error: unknown;
  count?: number | null;
}

const state = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; calls: Call[] }>,
  results: {} as Record<string, Result[]>,
  storage: [] as Array<{ bucket: string; method: string; args: unknown[] }>,
  signedUrl: {} as Record<string, { data: { signedUrl: string } | null; error: unknown }>,
  invokeEdge: vi.fn(),
  downloadBlob: vi.fn(),
  getDocument: vi.fn(),
  fetchDocument: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const entry = { table, calls: [] as Call[] };
    state.queries.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'update', 'insert', 'delete', 'ilike', 'maybeSingle']) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, args]);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const next = state.results[table]?.shift() ?? { data: [], error: null };
      return Promise.resolve(next).then(resolve, reject);
    };
    return b;
  }
  const storage = {
    from: (bucket: string) => ({
      createSignedUrl: async (...args: unknown[]) => {
        state.storage.push({ bucket, method: 'createSignedUrl', args });
        return state.signedUrl[bucket] ?? { data: null, error: new Error('not found') };
      },
      createSignedUrls: async (...args: unknown[]) => {
        state.storage.push({ bucket, method: 'createSignedUrls', args });
        return { data: [], error: null };
      },
    }),
  };
  return { getSupabase: () => ({ from: (table: string) => builder(table), storage }) };
});

vi.mock('@/lib/edge', async () => {
  const core = await vi.importActual<typeof import('@/lib/edgeCore')>('@/lib/edgeCore');
  return { invokeEdge: (...args: unknown[]) => state.invokeEdge(...args), isEdgeError: core.isEdgeError, EdgeError: core.EdgeError };
});
vi.mock('@/lib/download', () => ({ downloadBlob: (...args: unknown[]) => state.downloadBlob(...args) }));
vi.mock('@/features/documents/api', () => ({
  getDocument: (...args: unknown[]) => state.getDocument(...args),
  fetchDocument: (...args: unknown[]) => state.fetchDocument(...args),
}));

import {
  countPendingForContact,
  deleteEnvelopeDocument,
  downloadAudit,
  downloadSignedCopy,
  findContactsByEmail,
  getSigners,
  importStoredDocument,
  isRequiresForce,
  listEnvelopes,
  manageSigner,
  saveEsignSettings,
  setSignerFields,
  uploadDocument,
} from '../api';
import { FN, SIGNER_COLUMNS } from '../contract';

const callsOn = (table: string) => state.queries.filter((q) => q.table === table).map((q) => q.calls);
const methodArgs = (calls: Call[], method: string) => calls.filter(([m]) => m === method).map(([, a]) => a);

beforeEach(() => {
  state.queries = [];
  state.results = {};
  state.storage = [];
  state.signedUrl = {};
  state.invokeEdge.mockReset();
  state.downloadBlob.mockReset();
  state.getDocument.mockReset();
  state.fetchDocument.mockReset();
  vi.unstubAllGlobals();
});

describe('reads', () => {
  it('signers by the explicit column list, never *, never the token or phone ciphertext', async () => {
    await getSigners('env-1');
    const [calls] = callsOn('esign_envelope_signers');
    const select = String(methodArgs(calls, 'select')[0][0]);
    expect(select.startsWith(SIGNER_COLUMNS)).toBe(true);
    expect(select).not.toMatch(/\*|token_hash|token_expires_at|phone_ciphertext|phone_iv/);
    expect(methodArgs(calls, 'eq')).toEqual([['envelope_id', 'env-1']]);
  });

  it('keeps reading past a full page, keyed on id', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, order: i, contact: null }));
    state.results.esign_envelope_signers = [
      { data: full, error: null },
      { data: [{ id: 'zz', order: 1000, contact: null }], error: null },
    ];
    const rows = await getSigners('env-1');
    expect(rows).toHaveLength(1001);
    const [, second] = callsOn('esign_envelope_signers');
    expect(methodArgs(second, 'gt')).toEqual([['id', 's0999']]);
  });

  it('lists envelopes newest first, with the signer count from either embed shape', async () => {
    state.results.esign_envelopes = [
      {
        data: [
          { id: 'a', created_at: '2026-10-01T00:00:00Z', signers: [{ count: 2 }] },
          { id: 'b', created_at: '2026-10-03T00:00:00Z', signers: { count: 1 } },
        ],
        error: null,
      },
    ];
    const rows = await listEnvelopes('all');
    expect(rows.map((r) => [r.id, r.signer_count])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    expect(methodArgs(callsOn('esign_envelopes')[0], 'eq')).toEqual([]);
  });

  it('counts only what is waiting: draft, sent and partially signed', async () => {
    state.results.esign_envelopes = [{ data: null, error: null, count: 3 }];
    expect(await countPendingForContact('c1')).toBe(3);
    const [calls] = callsOn('esign_envelopes');
    expect(methodArgs(calls, 'select')[0]).toEqual(['id', { count: 'exact', head: true }]);
    expect(methodArgs(calls, 'in')).toEqual([['status', ['draft', 'sent', 'partially_signed']]]);
  });

  it('looks contacts up by own and spouse address, two rows at most each', async () => {
    await findContactsByEmail('ada\\_l@example.com');
    const [own, spouse] = [callsOn('contacts')[0], callsOn('contacts')[1]];
    expect(methodArgs(own, 'ilike')).toEqual([['email', 'ada\\_l@example.com']]);
    expect(methodArgs(spouse, 'ilike')).toEqual([['spouse_email', 'ada\\_l@example.com']]);
    expect(methodArgs(own, 'limit')).toEqual([[2]]);
    expect(methodArgs(spouse, 'limit')).toEqual([[2]]);
  });
});

describe('writes through the functions', () => {
  it('uploads a source PDF as multipart', async () => {
    state.invokeEdge.mockResolvedValue({ document: { id: 'd', page_count: 1 }, pages: [] });
    const file = new File(['%PDF-1.7'], 'Acme plan.pdf', { type: 'application/pdf' });
    await uploadDocument('env-1', file);
    const [name, body] = state.invokeEdge.mock.calls[0];
    expect(name).toBe(FN.uploadDocument);
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('envelope_id')).toBe('env-1');
    expect(form.get('file_name')).toBe('Acme plan.pdf');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('sends one signer per manage-signers call, and one signer’s fields per set', async () => {
    state.invokeEdge.mockResolvedValue({ signer_id: 's', count: 0, inserted_ids: [] });
    await manageSigner('env-1', 'add', { email: 'ada@example.com', order: 0, role: 'primary' });
    await setSignerFields('env-1', 's1', [{ signer_id: 's1', page_index: 0, field_type: 'date', x: 1, y: 2, width: 3, height: 4 }]);
    expect(state.invokeEdge.mock.calls[0].slice(0, 2)).toEqual([
      FN.manageSigners,
      { envelope_id: 'env-1', action: 'add', signer: { email: 'ada@example.com', order: 0, role: 'primary' } },
    ]);
    expect(state.invokeEdge.mock.calls[1].slice(0, 2)).toEqual([
      FN.manageFields,
      { envelope_id: 'env-1', action: 'set', signer_id: 's1', fields: [{ signer_id: 's1', page_index: 0, field_type: 'date', x: 1, y: 2, width: 3, height: 4 }] },
    ]);
  });

  it('recognises requires_force by code only', () => {
    expect(isRequiresForce(new EdgeError('conflict', { status: 409, code: 'requires_force' }))).toBe(true);
    expect(isRequiresForce(new EdgeError('conflict', { status: 409, code: 'other' }))).toBe(false);
    expect(isRequiresForce(new Error('requires_force'))).toBe(false);
  });
});

describe('deleting a draft document', () => {
  const pages = [
    { id: 'p1', order: 0, source_document_id: 'doc-a', deleted: false },
    { id: 'p2', order: 1, source_document_id: 'doc-b', deleted: false },
    { id: 'p3', order: 2, source_document_id: 'doc-b', deleted: true },
  ];

  it('retires its live pages through the reorder FIRST, then the row, and never removes the object', async () => {
    state.results.esign_envelope_pages = [{ data: pages, error: null }];
    state.results.esign_envelope_documents = [{ data: [{ id: 'doc-b' }], error: null }];
    state.invokeEdge.mockResolvedValue({});
    await deleteEnvelopeDocument('env-1', { id: 'doc-b' });
    expect(state.invokeEdge.mock.calls[0].slice(0, 2)).toEqual([FN.reorderPages, { envelope_id: 'env-1', operations: [{ page_id: 'p2', deleted: true }] }]);
    expect(methodArgs(callsOn('esign_envelope_documents')[0], 'eq')).toEqual([['id', 'doc-b']]);
    expect(state.storage).toEqual([]);
  });

  it('a refused row delete throws', async () => {
    state.results.esign_envelope_pages = [{ data: pages, error: null }];
    state.results.esign_envelope_documents = [{ data: [], error: null }];
    state.invokeEdge.mockResolvedValue({});
    await expect(deleteEnvelopeDocument('env-1', { id: 'doc-b' })).rejects.toThrow(/not removed/);
    expect(state.storage).toEqual([]);
  });
});

describe('downloads', () => {
  it('the audit trail must arrive as a PDF blob', async () => {
    state.invokeEdge.mockResolvedValueOnce({ not: 'a blob' });
    await expect(downloadAudit({ id: 'e', title: 'Acme plan' })).rejects.toThrow(/did not arrive/);
    state.invokeEdge.mockResolvedValueOnce(new Blob(['%PDF'], { type: 'application/pdf' }));
    await downloadAudit({ id: 'e', title: 'Acme: plan' });
    expect(state.downloadBlob.mock.calls[0][1]).toBe('Acme_ plan_audit.pdf');
  });

  it('the signed copy is read from the documents bucket, else the working bucket', async () => {
    state.signedUrl['esign-working'] = { data: { signedUrl: 'https://storage.example.com/s' }, error: null };
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await downloadSignedCopy({ title: 'Acme plan', signed_pdf_path: 'env/signed.pdf' });
    expect(state.storage.map((s) => s.bucket)).toEqual(['client-documents', 'esign-working']);
    expect(fetchMock).toHaveBeenCalledWith('https://storage.example.com/s');
    expect(state.downloadBlob.mock.calls[0][1]).toBe('Acme plan_signed.pdf');
  });

  it('no signed URL anywhere is an error, not a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadSignedCopy({ title: 't', signed_pdf_path: 'p' })).rejects.toThrow(/could not be opened/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('importing a stored document', () => {
  it('refuses anything but a PDF before reading it', async () => {
    state.getDocument.mockResolvedValue({ id: 'd', mime_type: 'image/png', original_filename: 'x.png' });
    await expect(importStoredDocument('env-1', 'd')).rejects.toThrow(/Only a PDF/);
    expect(state.fetchDocument).not.toHaveBeenCalled();
  });

  it('never uploads an error page from an expired link', async () => {
    state.getDocument.mockResolvedValue({ id: 'd', mime_type: 'application/pdf', original_filename: 'Acme plan.pdf' });
    state.fetchDocument.mockResolvedValue({ kind: 'redirect', url: 'https://storage.example.com/x' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 400 })));
    await expect(importStoredDocument('env-1', 'd')).rejects.toThrow(/could not be read/);
    expect(state.invokeEdge).not.toHaveBeenCalled();
  });
});

describe('settings', () => {
  it('updates the row, and inserts it only when none was updated', async () => {
    state.results.app_settings = [
      { data: [], error: null },
      { data: null, error: null },
    ];
    await saveEsignSettings({ filing_folder: '  Signed  ', sms_enabled: false });
    const [update, insert] = callsOn('app_settings');
    expect(methodArgs(update, 'update')).toEqual([[{ value: { filing_folder: 'Signed', sms_enabled: false } }]]);
    expect(methodArgs(update, 'eq')).toEqual([['key', 'esign']]);
    expect(methodArgs(insert, 'insert')).toEqual([[{ key: 'esign', value: { filing_folder: 'Signed', sms_enabled: false } }]]);
  });
});
