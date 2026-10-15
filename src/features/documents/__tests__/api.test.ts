// The query shapes the documents screens rely on.
//
// Contact scoping: the client_documents SELECT policy has a second arm for documents
// SHARED with the caller (shared_with_contact_id). A folder listing that filtered only on
// the path would let a document shared from a related contact appear inside the caller's
// own folder of the same path. Every listing therefore names the contact explicitly, and
// shared documents are read only by listSharedWithMe.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateName } from '../lib/documentNames';

type Call = [method: string, args: unknown[]];

const state = vi.hoisted(() => ({
  tables: [] as Array<{ table: string; calls: Call[] }>,
  pages: {} as Record<string, unknown[][]>,
  invokeEdge: vi.fn(),
  downloadBlob: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const entry = { table, calls: [] as Call[] };
    state.tables.push(entry);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit']) {
      b[m] = (...args: unknown[]) => {
        entry.calls.push([m, args]);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const page = state.pages[table]?.shift() ?? [];
      return Promise.resolve({ data: page, error: null }).then(resolve, reject);
    };
    return b;
  }
  return { getSupabase: () => ({ from: (table: string) => builder(table) }) };
});

vi.mock('@/lib/edge', () => ({ invokeEdge: (...args: unknown[]) => state.invokeEdge(...args) }));
vi.mock('@/lib/download', () => ({ downloadBlob: (...args: unknown[]) => state.downloadBlob(...args) }));

import {
  downloadDocument, folderChildCounts, listDocumentsAtPath, listFoldersAtPath, listSharedWithMe,
} from '../api';

beforeEach(() => {
  state.tables = [];
  state.pages = {};
  state.invokeEdge.mockReset();
  state.downloadBlob.mockReset();
});

const eqs = (calls: Call[]) => calls.filter(([m]) => m === 'eq').map(([, a]) => a);
const callsOn = (table: string) => state.tables.filter((t) => t.table === table).map((t) => t.calls);

describe('contact scoping on every folder listing', () => {
  it('listDocumentsAtPath filters on the contact, the path and the section', async () => {
    await listDocumentsAtPath('contact-ada', '/', 'client');
    const [calls] = callsOn('client_documents');
    expect(eqs(calls)).toEqual([['contact_id', 'contact-ada'], ['folder_path', '/'], ['held_by', 'client']]);
  });

  it('listFoldersAtPath filters on the contact, the parent path and the section', async () => {
    await listFoldersAtPath('contact-ada', '/Receipts/', 'owner');
    const [calls] = callsOn('client_folders');
    expect(eqs(calls)).toEqual([['contact_id', 'contact-ada'], ['parent_path', '/Receipts/'], ['held_by', 'owner']]);
  });

  it('folderChildCounts scopes BOTH reads by the contact and the section', async () => {
    await folderChildCounts('contact-ada', ['/Receipts/'], 'client');
    for (const table of ['client_folders', 'client_documents']) {
      const [calls] = callsOn(table);
      expect(eqs(calls), table).toEqual([['contact_id', 'contact-ada'], ['held_by', 'client']]);
    }
  });

  it('listSharedWithMe reads only what was shared with the contact', async () => {
    await listSharedWithMe('contact-ada');
    const [calls] = callsOn('client_documents');
    expect(eqs(calls)).toEqual([['shared_with_contact_id', 'contact-ada']]);
  });
});

describe('paging and order', () => {
  it('reads past 1,000 rows by id, never a silent cap, and sorts by name here', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `id-${String(i).padStart(4, '0')}`, original_filename: `File ${i}.pdf` }));
    state.pages.client_documents = [full, [{ id: 'id-9999', original_filename: 'file 2.pdf' }]];
    const rows = await listDocumentsAtPath('contact-ada', '/', 'client');
    expect(rows).toHaveLength(1001);
    const [first, second] = callsOn('client_documents');
    expect(first).toContainEqual(['order', ['id', { ascending: true }]]);
    expect(first.some(([m]) => m === 'gt')).toBe(false);
    expect(second).toContainEqual(['gt', ['id', 'id-0999']]);
    // Numeric and case-insensitive: "File 2" sorts before "File 10", wherever it was read.
    expect(rows.slice(0, 4).map((r) => r.original_filename)).toEqual(['File 0.pdf', 'File 1.pdf', 'File 2.pdf', 'file 2.pdf']);
  });
});

describe('downloadDocument', () => {
  it('names and types the file from the row, never from the answer', async () => {
    state.invokeEdge.mockResolvedValue(new Blob(['%PDF'], { type: 'application/octet-stream' }));
    await downloadDocument({ id: 'doc-1', filename: 'Acme LLC invoice.pdf', mimeType: 'application/pdf' });
    expect(state.invokeEdge).toHaveBeenCalledWith('decrypt-document', { document_id: 'doc-1', purpose: 'download' });
    const [blob, name] = state.downloadBlob.mock.calls[0] as [Blob, string];
    expect(name).toBe('Acme LLC invoice.pdf');
    expect(blob.type).toBe('application/pdf');
  });

  it('saves under the extension of the stored type, never the uploader’s', async () => {
    const cases: Array<[string, string, string]> = [
      ['run.hta', 'text/plain', 'run.txt'],
      ['setup.ps1', 'text/plain', 'setup.txt'],
      ['book.xlsm', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'book.xlsx'],
      ['letter.docm', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx'],
      ['scan.JPEG', 'image/jpeg', 'scan.JPEG'],
      ['Acme LLC notes', 'text/plain', 'Acme LLC notes.txt'],
      ['invoice\u202Efdp.exe', 'application/pdf', 'invoicefdp.pdf'],
      ['.hta', 'text/plain', 'document.txt'],
      ['blob.exe', 'application/octet-stream', 'blob.bin'],
    ];
    for (const [filename, mimeType, saved] of cases) {
      state.downloadBlob.mockReset();
      state.invokeEdge.mockResolvedValue(new Blob(['x']));
      await downloadDocument({ id: 'doc-1', filename, mimeType });
      expect([filename, (state.downloadBlob.mock.calls[0] as [Blob, string])[1]]).toEqual([filename, saved]);
    }
  });

  it('a rename or new folder with a Unicode format character is refused in the browser too', () => {
    for (const name of ['invoice\u202Efdp.exe', 'a\u200Bb', 'tag\u{E0041}']) expect(validateName(name), name).toMatch(/formatting/);
    expect(validateName('Acme LLC notes.txt')).toBeNull();
  });

  it('a plaintext document is fetched and saved under the same rule, never opened by its link', async () => {
    state.invokeEdge.mockResolvedValue({ mode: 'redirect', signed_url: 'https://example.com/o/x.pdf', filename: 'x', mime_type: 'application/pdf' });
    const fetchMock = vi.fn(async () => new Response('%PDF'));
    vi.stubGlobal('fetch', fetchMock);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await downloadDocument({ id: 'doc-1', filename: 'Signed.hta', mimeType: 'application/pdf' });
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/o/x.pdf');
      expect(open).not.toHaveBeenCalled();
      expect((state.downloadBlob.mock.calls[0] as [Blob, string])[1]).toBe('Signed.pdf');
    } finally {
      vi.unstubAllGlobals();
      open.mockRestore();
    }
  });
});
