// @vitest-environment node
// esign-upload-document against the real migrations: a PDF becomes a document and its
// pages in a draft, anything else is refused before it is stored, and a failed insert
// takes its stored object with it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { createUploadDocumentHandler, type UploadDocumentDeps } from '../../../supabase/functions/esign-upload-document/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID } from './contract';
import { createWorld, makePdf, ORIGINS, pdfTools, type World } from './esign-world';

let w: World;

function deps(over: Partial<UploadDocumentDeps> = {}): UploadDocumentDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    storage: w.storage,
    pdf: pdfTools(),
    logSink: w.logSink,
    ...over,
  };
}

function form(envelopeId: string, bytes: Uint8Array | string, opts: { type?: string; name?: string } = {}): FormData {
  const f = new FormData();
  f.append('file', new Blob([bytes as BlobPart], { type: opts.type ?? 'application/pdf' }), 'upload.pdf');
  f.append('envelope_id', envelopeId);
  f.append('file_name', opts.name ?? 'Letter.pdf');
  return f;
}

const upload = (body: FormData, d = deps()) => createUploadDocumentHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

async function draft(status = 'draft'): Promise<string> {
  const [row] = await w.q<{ id: string }>(
    `INSERT INTO public.esign_envelopes (created_by, title, status, expires_at) VALUES ($1, 'Letter', $2, CASE WHEN $2 = 'draft' THEN NULL ELSE now() + interval '1 day' END) RETURNING id`,
    [OWNER_ID, status],
  );
  return row.id;
}

// Read when the suite is declared, so built at module load.
const validForm = form(randomUUID(), await makePdf(1));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-upload-document', () => {
  describeEdgeContract({
    name: 'esign-upload-document',
    get handler() {
      return createUploadDocumentHandler(deps());
    },
    get failingHandler() {
      return createUploadDocumentHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); } } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: {
      kind: 'form',
      valid: validForm,
      maxBytes: 27_262_976,
    },
  });

  it('stores the PDF and answers the document and its pages in order', async () => {
    const env = await draft();
    const first = await upload(form(env, await makePdf(2), { name: 'Letter\u0007.pdf' }));
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a.document).toMatchObject({ file_name: 'Letter.pdf', page_count: 2, order: 0 });
    expect(a.pages.map((p: { order: number; source_page_index: number }) => [p.order, p.source_page_index])).toEqual([[0, 0], [1, 1]]);
    expect(w.storage.working.has(`${env}/sources/${a.document.id}.pdf`)).toBe(true);

    const second = await upload(form(env, await makePdf(1)));
    const b = await second.json();
    expect(b.document.order).toBe(1);
    expect(b.pages.map((p: { order: number }) => p.order)).toEqual([2]);
  });

  it('refuses a non-PDF, a disguised file and an unreadable PDF before storing anything', async () => {
    const env = await draft();
    const before = w.storage.working.size;
    const cases: Array<[FormData, string]> = [
      [form(env, await makePdf(1), { type: 'image/png' }), 'not_pdf'],
      [form(env, 'GIF89a not a pdf at all'), 'not_pdf'],
      [form(env, '%PDF-1.7 truncated garbage'), 'unreadable_pdf'],
      [form(env, new Uint8Array(0)), 'file_too_large'],
    ];
    for (const [body, code] of cases) {
      const res = await upload(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(code);
    }
    expect(w.storage.working.size).toBe(before);
  });

  it('refuses an encrypted PDF', async () => {
    const env = await draft();
    // A PDF whose trailer names an Encrypt dictionary is refused by pdf-lib's load.
    const doc = await pdfLib.PDFDocument.create();
    doc.addPage();
    const plain = new TextDecoder('latin1').decode(await doc.save({ useObjectStreams: false }));
    expect(plain).toContain('trailer');
    const encrypted = plain.replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>');
    const res = await upload(form(env, new TextEncoder().encode(encrypted)));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unreadable_pdf');
  });

  it('refuses more than 200 pages, in one file or in the envelope', async () => {
    const env = await draft();
    const big = await makePdf(201);
    const res = await upload(form(env, big));
    expect((await res.json()).code).toBe('too_many_pages');
    expect((await upload(form(env, await makePdf(200)))).status).toBe(200);
    const over = await upload(form(env, await makePdf(1)));
    expect(over.status).toBe(409);
    expect((await over.json()).code).toBe('too_many_pages');
  });

  it('refuses a sent envelope (409) and an unknown one (404), storing nothing', async () => {
    const before = w.storage.working.size;
    const sent = await upload(form(await draft('sent'), await makePdf(1)));
    expect(sent.status).toBe(409);
    expect((await sent.json()).code).toBe('not_draft');
    expect((await upload(form(randomUUID(), await makePdf(1)))).status).toBe(404);
    expect(w.storage.working.size).toBe(before);
  });

  it('removes the stored object when the insert fails', async () => {
    const env = await draft();
    const id = randomUUID();
    // The RPC refuses: the envelope is sent between the check and the insert.
    const racing = deps({
      newId: () => id,
      storage: Object.assign(Object.create(w.storage), {
        putWorking: async (path: string, bytes: Uint8Array, o: { upsert: boolean }) => {
          await w.storage.putWorking(path, bytes, o);
          await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [env]);
        },
      }),
    });
    const res = await upload(form(env, await makePdf(1)), racing);
    expect(res.status).toBe(409);
    expect(w.storage.working.has(`${env}/sources/${id}.pdf`)).toBe(false);
    expect(w.storage.removed).toContain(`${env}/sources/${id}.pdf`);
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [id])).toEqual([]);
  });

  it('uses the injected pdf-lib (sanity: the page count is pdf-lib\'s)', async () => {
    const doc = await pdfLib.PDFDocument.load(await makePdf(3));
    expect(await pdfTools().pageCount(await doc.save())).toBe(3);
  });
});
