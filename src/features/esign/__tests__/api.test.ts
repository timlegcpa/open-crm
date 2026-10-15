// The owner-side reads and writes: explicit columns, keyset paging, every call's body and
// the answer it parses (the server's shapes), the server-side document delete, the send
// refusal's problem list, the signed copy opened through the documents feature, the
// settings write.
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
  downloadDocument: vi.fn(),
  functionsInvoke: vi.fn(),
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
  const functions = { invoke: (...args: unknown[]) => state.functionsInvoke(...args) };
  return { getSupabase: () => ({ from: (table: string) => builder(table), storage, functions }) };
});

vi.mock('@/lib/edge', async () => {
  const core = await vi.importActual<typeof import('@/lib/edgeCore')>('@/lib/edgeCore');
  const actual = await vi.importActual<typeof import('@/lib/edge')>('@/lib/edge');
  return {
    invokeEdge: (...args: unknown[]) => state.invokeEdge(...args),
    toEdgeError: actual.toEdgeError,
    isEdgeError: core.isEdgeError,
    EdgeError: core.EdgeError,
  };
});
vi.mock('@/lib/download', () => ({ downloadBlob: (...args: unknown[]) => state.downloadBlob(...args) }));
vi.mock('@/features/documents/api', () => ({
  getDocument: (...args: unknown[]) => state.getDocument(...args),
  fetchDocument: (...args: unknown[]) => state.fetchDocument(...args),
  downloadDocument: (...args: unknown[]) => state.downloadDocument(...args),
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
  sendEnvelope,
  SendNotReadyError,
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
  state.downloadDocument.mockReset();
  state.functionsInvoke.mockReset();
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
    state.invokeEdge.mockImplementation((_name: string, _body: unknown, opts: { parse: (d: unknown) => unknown }) =>
      opts.parse({ document: { id: 'd', file_name: 'Acme plan.pdf', page_count: 1, order: 0 }, pages: [{ id: 'p', order: 0, source_page_index: 0 }] }));
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

  it('shortens a file name past the server’s 200 characters, keeping the extension', async () => {
    state.invokeEdge.mockResolvedValue({});
    await uploadDocument('env-1', new File(['%PDF-1.7'], `${'a'.repeat(250)}.pdf`, { type: 'application/pdf' }));
    const name = String((state.invokeEdge.mock.calls[0][1] as FormData).get('file_name'));
    expect(name).toHaveLength(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('parses each manage-signers action by its own answer (remove answers success only)', async () => {
    const answers: Record<string, unknown> = {
      add: { success: true, signer_id: 's', contact_id: 'c' },
      update: { success: true, signer_id: 's' },
      remove: { success: true },
    };
    state.invokeEdge.mockImplementation((_name: string, body: { action: string }, opts: { parse: (d: unknown) => unknown }) => Promise.resolve(opts.parse(answers[body.action])));
    await expect(manageSigner('env-1', 'add', { email: 'ada@example.com', order: 0 })).resolves.toEqual(answers.add);
    await expect(manageSigner('env-1', 'update', { signer_id: 's', order: 1 })).resolves.toEqual(answers.update);
    await expect(manageSigner('env-1', 'remove', { signer_id: 's' })).resolves.toEqual(answers.remove);
  });

  it('sends one signer per manage-signers call, and one signer’s fields per set', async () => {
    state.invokeEdge.mockResolvedValue({ signer_id: 's', count: 0, inserted_ids: [] });
    await manageSigner('env-1', 'add', { email: 'ada@example.com', order: 0, role: 'primary' });
    await setSignerFields('env-1', 's1', [{ page_index: 0, field_type: 'date', x: 1, y: 2, width: 3, height: 4 }]);
    expect(state.invokeEdge.mock.calls[0].slice(0, 2)).toEqual([
      FN.manageSigners,
      { envelope_id: 'env-1', action: 'add', signer: { email: 'ada@example.com', order: 0, role: 'primary' } },
    ]);
    expect(state.invokeEdge.mock.calls[1].slice(0, 2)).toEqual([
      FN.manageFields,
      { envelope_id: 'env-1', action: 'set', signer_id: 's1', fields: [{ page_index: 0, field_type: 'date', x: 1, y: 2, width: 3, height: 4 }] },
    ]);
  });

  it('recognises requires_force by code only', () => {
    expect(isRequiresForce(new EdgeError('conflict', { status: 409, code: 'requires_force' }))).toBe(true);
    expect(isRequiresForce(new EdgeError('conflict', { status: 409, code: 'other' }))).toBe(false);
    expect(isRequiresForce(new Error('requires_force'))).toBe(false);
  });
});

describe('deleting a draft document', () => {
  it('is one server call, and the browser touches no row and no storage object', async () => {
    state.invokeEdge.mockImplementation((_n: string, _b: unknown, opts: { parse: (d: unknown) => unknown }) => opts.parse({ ok: true }));
    await deleteEnvelopeDocument('env-1', { id: 'doc-b' });
    expect(state.invokeEdge.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [FN.reorderPages, { action: 'delete_document', envelope_id: 'env-1', document_id: 'doc-b' }],
    ]);
    expect(state.queries).toEqual([]);
    expect(state.storage).toEqual([]);
  });

  it('a refusal (the envelope was sent) is thrown as the server said it', async () => {
    state.invokeEdge.mockRejectedValue(new EdgeError('conflict', { status: 409, code: 'not_draft' }));
    await expect(deleteEnvelopeDocument('env-1', { id: 'doc-b' })).rejects.toMatchObject({ code: 'not_draft' });
  });
});

describe('sending', () => {
  /** What functions.invoke returns for a non-2xx: the Response on error.context. */
  const httpError = (status: number, body: unknown) => ({
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    }),
  });

  it('a draft that is not ready throws every problem the server listed, with its code and sentence', async () => {
    state.functionsInvoke.mockResolvedValue(
      httpError(400, {
        error: 'This envelope has 2 problems to fix before it can be sent.',
        code: 'validation_failed',
        validation: ['At least one page is required.', 'Signer ada@example.com has no required fields.'],
      }),
    );
    const err = await sendEnvelope('env-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendNotReadyError);
    expect(err).toMatchObject({
      code: 'validation_failed',
      status: 400,
      message: 'This envelope has 2 problems to fix before it can be sent.',
      problems: ['At least one page is required.', 'Signer ada@example.com has no required fields.'],
    });
    expect(state.functionsInvoke.mock.calls[0]).toEqual([FN.sendEnvelope, { body: { envelope_id: 'env-1' }, method: 'POST' }]);
  });

  it('any other refusal is a plain edge error', async () => {
    state.functionsInvoke.mockResolvedValue(httpError(409, { error: 'Text message codes are not available.', code: 'sms_unavailable' }));
    const err = await sendEnvelope('env-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeError);
    expect(err).not.toBeInstanceOf(SendNotReadyError);
    expect(err).toMatchObject({ code: 'sms_unavailable' });
  });

  it('parses the server’s answer', async () => {
    state.functionsInvoke.mockResolvedValue({ data: { ok: true, envelope_id: 'env-1', signers_invited: 2, failed_emails: [] }, error: null });
    await expect(sendEnvelope('env-1')).resolves.toEqual({ ok: true, envelope_id: 'env-1', signers_invited: 2, failed_emails: [] });
    state.functionsInvoke.mockResolvedValue({ data: { signers_invited: 2 }, error: null });
    await expect(sendEnvelope('env-1')).rejects.toBeInstanceOf(EdgeError);
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

  it('the signed copy is the filed documents row finalize wrote, opened through the documents feature', async () => {
    state.results.client_documents = [{ data: { id: 'doc-1', original_filename: 'Acme plan.pdf', mime_type: 'application/pdf' }, error: null }];
    await downloadSignedCopy({ id: 'env-1', signed_pdf_path: 'c1/esign/env-1.pdf' });
    const [calls] = callsOn('client_documents');
    expect(methodArgs(calls, 'eq')).toEqual([['esign_envelope_id', 'env-1']]);
    expect(state.downloadDocument).toHaveBeenCalledWith({ id: 'doc-1', filename: 'Acme plan.pdf', mimeType: 'application/pdf' });
    // Never a guessed path in either bucket.
    expect(state.storage).toEqual([]);
  });

  it('no filed row yet is an error, not a guess', async () => {
    state.results.client_documents = [{ data: null, error: null }];
    await expect(downloadSignedCopy({ id: 'env-1', signed_pdf_path: 'c1/esign/env-1.pdf' })).rejects.toThrow(/not filed/);
    expect(state.downloadDocument).not.toHaveBeenCalled();
    expect(state.storage).toEqual([]);
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

  it('uploads a stored PDF under a name the server accepts', async () => {
    state.getDocument.mockResolvedValue({ id: 'd', mime_type: 'application/pdf', original_filename: `${'n'.repeat(240)}.pdf` });
    state.fetchDocument.mockResolvedValue({ kind: 'bytes', blob: new Blob(['%PDF-1.7']) });
    state.invokeEdge.mockResolvedValue({});
    await importStoredDocument('env-1', 'd');
    const form = state.invokeEdge.mock.calls[0][1] as FormData;
    expect(String(form.get('file_name'))).toHaveLength(200);
    expect((form.get('file') as File).type).toBe('application/pdf');
  });
});

describe('settings', () => {
  it('updates the row, and inserts it only when none was updated', async () => {
    state.results.app_settings = [
      { data: [], error: null },
      { data: null, error: null },
    ];
    await saveEsignSettings({ filing_folder: '  Signed / Agreements ', sms_enabled: false });
    const [update, insert] = callsOn('app_settings');
    expect(methodArgs(update, 'update')).toEqual([[{ value: { filing_folder: 'Signed/Agreements', sms_enabled: false } }]]);
    expect(methodArgs(update, 'eq')).toEqual([['key', 'esign']]);
    expect(methodArgs(insert, 'insert')).toEqual([[{ key: 'esign', value: { filing_folder: 'Signed/Agreements', sms_enabled: false } }]]);
  });
});
