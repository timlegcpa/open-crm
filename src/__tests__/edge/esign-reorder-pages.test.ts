// @vitest-environment node
// esign-reorder-pages against the real migrations, plus the pure remap it relies on:
// every field follows its page, a deleted page takes its fields with it, and a deleted
// source document takes its pages, its fields and its working object.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { remapFieldsForReorder } from '../../../supabase/functions/esign-finalize-envelope/lib/page-reorder';
import { createReorderPagesHandler, type ReorderPagesDeps } from '../../../supabase/functions/esign-reorder-pages/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth } from './contract';
import { addField, createWorld, makePdf, ORIGINS, seedDraft, type World } from './esign-world';

let w: World;

function deps(over: Partial<ReorderPagesDeps> = {}): ReorderPagesDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, storage: w.storage, logSink: w.logSink, ...over };
}
const reorder = (body: unknown) => createReorderPagesHandler(deps())(edgeRequest({ headers: CREDENTIALS.owner, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('remapFieldsForReorder', () => {
  const pages = [
    { id: 'a', order: 0, deleted: false },
    { id: 'b', order: 1, deleted: false },
    { id: 'c', order: 2, deleted: false },
  ];
  it('moves fields with a swap', () => {
    const r = remapFieldsForReorder(pages, [{ page_id: 'a', order: 1 }, { page_id: 'b', order: 0 }], [
      { id: 'f0', page_index: 0 },
      { id: 'f1', page_index: 1 },
      { id: 'f2', page_index: 2 },
    ]);
    expect(r).toEqual({ updates: [{ id: 'f0', page_index: 1 }, { id: 'f1', page_index: 0 }], deletes: [] });
  });
  it('drops the fields of a deleted page and shifts the later ones down', () => {
    const r = remapFieldsForReorder(pages, [{ page_id: 'b', deleted: true }], [
      { id: 'f0', page_index: 0 },
      { id: 'f1', page_index: 1 },
      { id: 'f2', page_index: 2 },
    ]);
    expect(r).toEqual({ updates: [{ id: 'f2', page_index: 1 }], deletes: ['f1'] });
  });
  it('drops a field already orphaned on a page that does not exist', () => {
    expect(remapFieldsForReorder(pages, [], [{ id: 'x', page_index: 7 }])).toEqual({ updates: [], deletes: ['x'] });
  });
  it('keeps a restored page\'s position', () => {
    const withDeleted = [...pages, { id: 'd', order: 3, deleted: true }];
    const r = remapFieldsForReorder(withDeleted, [{ page_id: 'd', deleted: false, order: 0 }, { page_id: 'a', order: 4 }], [{ id: 'f1', page_index: 1 }]);
    // b stays at order 1 -> now position 1 of [d(0), b(1), c(2), a(4)].
    expect(r).toEqual({ updates: [], deletes: [] });
  });
});

describe('esign-reorder-pages', () => {
  describeEdgeContract({
    name: 'esign-reorder-pages',
    get handler() {
      return createReorderPagesHandler(deps());
    },
    get failingHandler() {
      return createReorderPagesHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); } } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: randomUUID(), operations: [{ page_id: randomUUID(), order: 1 }] }, maxBytes: 65_536 },
  });

  it('swaps two pages and their fields follow, in one call', async () => {
    const d = await seedDraft(w, { pages: 3, signers: [{ email: 'a@example.com' }] });
    const f0 = await addField(w, d.envelopeId, d.signerIds[0], 0);
    const f2 = await addField(w, d.envelopeId, d.signerIds[0], 2);
    const res = await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0], order: 2 }, { page_id: d.pageIds[2], order: 0 }] });
    expect(await res.json()).toEqual({ ok: true });
    const fields = await w.q<{ id: string; page_index: number }>(`SELECT id, page_index FROM public.esign_envelope_fields WHERE envelope_id = $1 ORDER BY page_index`, [d.envelopeId]);
    expect(fields).toEqual([{ id: f2, page_index: 0 }, { id: f0, page_index: 2 }]);
  });

  it('deletes a page with its fields', async () => {
    const d = await seedDraft(w, { pages: 2, signers: [{ email: 'a@example.com' }] });
    const gone = await addField(w, d.envelopeId, d.signerIds[0], 0);
    const kept = await addField(w, d.envelopeId, d.signerIds[0], 1);
    await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0], deleted: true }] });
    expect(await w.q(`SELECT id, page_index FROM public.esign_envelope_fields WHERE envelope_id = $1`, [d.envelopeId])).toEqual([{ id: kept, page_index: 0 }]);
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_fields WHERE id = $1`, [gone])).toEqual([]);
  });

  it('refuses a page of another envelope, a duplicate, an empty operation and a sent envelope', async () => {
    const d = await seedDraft(w, { pages: 2 });
    const other = await seedDraft(w, { pages: 1 });
    const foreign = await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: other.pageIds[0], order: 5 }] });
    expect([foreign.status, (await foreign.json()).code]).toEqual([400, 'page_not_found']);
    expect((await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0], order: 1 }, { page_id: d.pageIds[0], order: 0 }] })).status).toBe(400);
    expect((await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0] }] })).status).toBe(400);
    expect((await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0], order: 1 }] })).status).toBe(400);
    await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [d.envelopeId]);
    const sent = await reorder({ envelope_id: d.envelopeId, operations: [{ page_id: d.pageIds[0], order: 9 }] });
    expect([sent.status, (await sent.json()).code]).toEqual([409, 'not_draft']);
  });

  describe('delete_document', () => {
    /** A second source document of `pages` pages on an existing draft, stored like an upload. */
    async function addDocument(envelopeId: string, pages: number) {
      const documentId = randomUUID();
      const path = `${envelopeId}/sources/${documentId}.pdf`;
      const pdf = await makePdf(pages);
      w.storage.working.set(path, pdf);
      const [res] = await w.q<{ r: { pages: Array<{ id: string }> } }>(
        `SELECT public.esign_insert_document_with_pages($1, $2, 'second.pdf', $3, $4, $5) AS r`,
        [envelopeId, documentId, path, pdf.byteLength, pages],
      );
      return { documentId, path, pageIds: res.r.pages.map((p) => p.id) };
    }
    const del = (envelope_id: string, document_id: string) => reorder({ action: 'delete_document', envelope_id, document_id });

    it('removes the document, its pages and their fields, moves later fields up, and removes the working object', async () => {
      const d = await seedDraft(w, { pages: 2, signers: [{ email: 'a@example.com' }] });
      const second = await addDocument(d.envelopeId, 2);
      const third = await addDocument(d.envelopeId, 1);
      const onFirst = await addField(w, d.envelopeId, d.signerIds[0], 1);
      const onSecond = await addField(w, d.envelopeId, d.signerIds[0], 2);
      const onThird = await addField(w, d.envelopeId, d.signerIds[0], 4);

      const res = await del(d.envelopeId, second.documentId);
      expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [second.documentId])).toEqual([]);
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_pages WHERE source_document_id = $1`, [second.documentId])).toEqual([]);
      const fields = await w.q<{ id: string; page_index: number }>(
        `SELECT id, page_index FROM public.esign_envelope_fields WHERE envelope_id = $1 ORDER BY page_index`, [d.envelopeId]);
      expect(fields).toEqual([{ id: onFirst, page_index: 1 }, { id: onThird, page_index: 2 }]);
      expect(fields.map((f) => f.id)).not.toContain(onSecond);
      expect(w.storage.working.has(second.path)).toBe(false);
      expect(w.storage.working.has(third.path)).toBe(true);
    });

    it('refuses a sent envelope, and a document of another envelope, touching nothing', async () => {
      const d = await seedDraft(w, { pages: 1 });
      const other = await seedDraft(w, { pages: 1 });
      const foreign = await del(d.envelopeId, other.documentId);
      expect([foreign.status, (await foreign.json()).code]).toEqual([404, 'document_not_found']);
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [other.documentId])).toHaveLength(1);
      expect(w.storage.working.has(`${other.envelopeId}/sources/${other.documentId}.pdf`)).toBe(true);

      await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [d.envelopeId]);
      const sent = await del(d.envelopeId, d.documentId);
      expect([sent.status, (await sent.json()).code]).toEqual([409, 'not_draft']);
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [d.documentId])).toHaveLength(1);
      expect(w.storage.working.has(`${d.envelopeId}/sources/${d.documentId}.pdf`)).toBe(true);
      expect((await del(d.envelopeId, 'not-a-uuid')).status).toBe(400);
    });

    it('the database refuses a draft that was sent after the read (the lock and the status check)', async () => {
      const d = await seedDraft(w, { pages: 1 });
      await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [d.envelopeId]);
      await expect(w.q(`SELECT public.esign_delete_draft_document($1, $2, '[]'::jsonb, '{}'::uuid[])`, [d.envelopeId, d.documentId])).rejects.toThrow(/not a draft/);
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [d.documentId])).toHaveLength(1);
    });

    it('a failed object removal still answers ok (the row is gone) and is logged', async () => {
      const d = await seedDraft(w, { pages: 1 });
      w.storage.fail.add('removeWorking');
      try {
        const res = await del(d.envelopeId, d.documentId);
        expect(res.status).toBe(200);
      } finally {
        w.storage.fail.delete('removeWorking');
      }
      expect(await w.q(`SELECT 1 FROM public.esign_envelope_documents WHERE id = $1`, [d.documentId])).toEqual([]);
      expect(JSON.stringify(w.logs)).toMatch(/stranded/);
    });
  });
});
