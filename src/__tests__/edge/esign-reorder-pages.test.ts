// @vitest-environment node
// esign-reorder-pages against the real migrations, plus the pure remap it relies on:
// every field follows its page, a deleted page takes its fields with it.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { remapFieldsForReorder } from '../../../supabase/functions/esign-finalize-envelope/lib/page-reorder';
import { createReorderPagesHandler, type ReorderPagesDeps } from '../../../supabase/functions/esign-reorder-pages/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth } from './contract';
import { addField, createWorld, ORIGINS, seedDraft, type World } from './esign-world';

let w: World;

function deps(over: Partial<ReorderPagesDeps> = {}): ReorderPagesDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, logSink: w.logSink, ...over };
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
});
