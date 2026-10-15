// @vitest-environment node
// esign-manage-fields against the real migrations: one signer's boxes replaced at once,
// ids in the order drawn, draft only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createManageFieldsHandler, type ManageFieldsDeps } from '../../../supabase/functions/esign-manage-fields/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth } from './contract';
import { addField, createWorld, ORIGINS, seedDraft, type World } from './esign-world';

let w: World;

function deps(over: Partial<ManageFieldsDeps> = {}): ManageFieldsDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, logSink: w.logSink, ...over };
}
const manage = (body: unknown) => createManageFieldsHandler(deps())(edgeRequest({ headers: CREDENTIALS.owner, body }));
const box = (page_index: number, field_type: 'signature' | 'date' = 'signature') => ({ page_index, field_type, x: 10, y: 20, width: 100, height: 30 });

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-manage-fields', () => {
  describeEdgeContract({
    name: 'esign-manage-fields',
    get handler() {
      return createManageFieldsHandler(deps());
    },
    get failingHandler() {
      return createManageFieldsHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); } } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: randomUUID(), action: 'remove', field_id: randomUUID() }, maxBytes: 131_072 },
  });

  it('replaces one signer\'s fields and answers the new ids in input order', async () => {
    const { envelopeId, signerIds: [a, b] } = await seedDraft(w, { signers: [{ email: 'a@example.com' }, { email: 'b@example.com' }] });
    const other = await addField(w, envelopeId, b);
    await addField(w, envelopeId, a);
    const res = await manage({ envelope_id: envelopeId, action: 'set', signer_id: a, fields: [box(1), box(0, 'date'), { ...box(1), required: false }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);
    const stored = await w.q<{ id: string; page_index: number; field_type: string; required: boolean }>(
      `SELECT id, page_index, field_type, required FROM public.esign_envelope_fields WHERE signer_id = $1`, [a]);
    const byId = new Map(stored.map((s) => [s.id, s]));
    expect(body.inserted_ids.map((id: string) => byId.get(id))).toEqual([
      expect.objectContaining({ page_index: 1, field_type: 'signature', required: true }),
      expect.objectContaining({ page_index: 0, field_type: 'date' }),
      expect.objectContaining({ page_index: 1, required: false }),
    ]);
    // The other signer's box is untouched.
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_fields WHERE id = $1`, [other])).toHaveLength(1);
  });

  it('refuses out-of-shape boxes and more than 200, touching nothing', async () => {
    const { envelopeId, signerIds: [a] } = await seedDraft(w, { signers: [{ email: 'a@example.com' }] });
    const kept = await addField(w, envelopeId, a);
    for (const bad of [{ ...box(0), width: 0 }, { ...box(0), x: -1 }, { ...box(200) }, { ...box(0), field_type: 'initials' }, { ...box(0), required: 'yes' }]) {
      const res = await manage({ envelope_id: envelopeId, action: 'set', signer_id: a, fields: [bad] });
      expect([res.status, (await res.json()).code]).toEqual([400, 'invalid_fields']);
    }
    const many = await manage({ envelope_id: envelopeId, action: 'set', signer_id: a, fields: Array.from({ length: 201 }, () => box(0)) });
    expect((await many.json()).code).toBe('too_many_fields');
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_fields WHERE id = $1`, [kept])).toHaveLength(1);
  });

  it('refuses a signer of another envelope (404) and a sent envelope (409)', async () => {
    const one = await seedDraft(w, { signers: [{ email: 'a@example.com' }] });
    const two = await seedDraft(w, { signers: [{ email: 'b@example.com' }] });
    const res = await manage({ envelope_id: one.envelopeId, action: 'set', signer_id: two.signerIds[0], fields: [box(0)] });
    expect([res.status, (await res.json()).code]).toEqual([404, 'signer_not_found']);
    await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [one.envelopeId]);
    const sent = await manage({ envelope_id: one.envelopeId, action: 'set', signer_id: one.signerIds[0], fields: [box(0)] });
    expect([sent.status, (await sent.json()).code]).toEqual([409, 'not_draft']);
  });

  it('removes one field of this envelope only', async () => {
    const one = await seedDraft(w, { signers: [{ email: 'a@example.com' }] });
    const two = await seedDraft(w, { signers: [{ email: 'b@example.com' }] });
    const f = await addField(w, two.envelopeId, two.signerIds[0]);
    const wrong = await manage({ envelope_id: one.envelopeId, action: 'remove', field_id: f });
    expect([wrong.status, (await wrong.json()).code]).toEqual([404, 'field_not_found']);
    const ok = await manage({ envelope_id: two.envelopeId, action: 'remove', field_id: f });
    expect(await ok.json()).toEqual({ success: true, ok: true });
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_fields WHERE id = $1`, [f])).toEqual([]);
  });
});
