// @vitest-environment node
// esign-manage-templates against the real migrations: a layout saved from the primary
// and co-signer boxes, applied back by role, with off-the-end pages skipped.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createManageTemplatesHandler, type ManageTemplatesDeps } from '../../../supabase/functions/esign-manage-templates/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID } from './contract';
import { addField, createWorld, ORIGINS, seedDraft, type World } from './esign-world';

let w: World;

function deps(over: Partial<ManageTemplatesDeps> = {}): ManageTemplatesDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, logSink: w.logSink, ...over };
}
const manage = (body: unknown) => createManageTemplatesHandler(deps())(edgeRequest({ headers: CREDENTIALS.owner, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-manage-templates', () => {
  describeEdgeContract({
    name: 'esign-manage-templates',
    get handler() {
      return createManageTemplatesHandler(deps());
    },
    get failingHandler() {
      return createManageTemplatesHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); } } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { action: 'apply_to_envelope', envelope_id: randomUUID(), template_id: randomUUID() }, maxBytes: 65_536 },
  });

  it('saves only primary and co-signer boxes, then applies them by role and scope', async () => {
    const src = await seedDraft(w, {
      pages: 3,
      signers: [{ email: 'p@example.com', role: 'primary' }, { email: 'c@example.com', role: 'co_signer' }, { email: 'o@example.com' }],
    });
    await addField(w, src.envelopeId, src.signerIds[0], 0);
    await addField(w, src.envelopeId, src.signerIds[0], 2, 'date');
    await addField(w, src.envelopeId, src.signerIds[1], 1);
    await addField(w, src.envelopeId, src.signerIds[2], 1);
    const saved = await manage({ action: 'save_from_envelope', envelope_id: src.envelopeId, name: 'Two signers', description: 'Letter' });
    const s = await saved.json();
    expect(s).toEqual({ success: true, template_id: expect.any(String), field_count: 3 });
    const [tpl] = await w.q<{ page_count: number; created_by: string }>(`SELECT page_count, created_by FROM public.esign_templates WHERE id = $1`, [s.template_id]);
    expect(tpl).toEqual({ page_count: 3, created_by: OWNER_ID });

    // Same name again: 409.
    const dup = await manage({ action: 'save_from_envelope', envelope_id: src.envelopeId, name: 'two SIGNERS' });
    expect([dup.status, (await dup.json()).code]).toEqual([409, 'duplicate_name']);

    // A 2-page draft: the page-3 box is skipped.
    const dst = await seedDraft(w, { pages: 2, signers: [{ email: 'p2@example.com', role: 'primary' }, { email: 'c2@example.com', role: 'co_signer' }] });
    const primaryOnly = await (await manage({ action: 'apply_to_envelope', envelope_id: dst.envelopeId, template_id: s.template_id, scope: 'primary_only' })).json();
    expect(primaryOnly).toEqual({ success: true, inserted_count: 1, skipped_count: 2, template_page_count: 3, envelope_page_count: 2 });
    const both = await (await manage({ action: 'apply_to_envelope', envelope_id: dst.envelopeId, template_id: s.template_id, scope: 'with_co_signer' })).json();
    expect(both.inserted_count).toBe(2);
    const placed = await w.q<{ signer_id: string; page_index: number }>(
      `SELECT signer_id, page_index FROM public.esign_envelope_fields WHERE envelope_id = $1 ORDER BY signer_id, page_index`, [dst.envelopeId]);
    expect(placed.filter((p) => p.signer_id === dst.signerIds[1])).toEqual([{ signer_id: dst.signerIds[1], page_index: 1 }]);
  });

  it('needs a primary signer, a co-signer for with_co_signer, and something to save', async () => {
    const src = await seedDraft(w, { signers: [{ email: 'o@example.com' }] });
    await addField(w, src.envelopeId, src.signerIds[0], 0);
    const none = await manage({ action: 'save_from_envelope', envelope_id: src.envelopeId, name: 'Nothing' });
    expect([none.status, (await none.json()).code]).toEqual([400, 'no_template_fields']);

    const base = await seedDraft(w, { signers: [{ email: 'p@example.com', role: 'primary' }] });
    await addField(w, base.envelopeId, base.signerIds[0], 0);
    const { template_id } = await (await manage({ action: 'save_from_envelope', envelope_id: base.envelopeId, name: 'Primary only' })).json();
    const noPrimary = await manage({ action: 'apply_to_envelope', envelope_id: src.envelopeId, template_id });
    expect((await noPrimary.json()).code).toBe('primary_signer_required');
    const noCo = await manage({ action: 'apply_to_envelope', envelope_id: base.envelopeId, template_id, scope: 'with_co_signer' });
    expect((await noCo.json()).code).toBe('co_signer_required');
  });

  it('refuses a deleted template and a sent envelope', async () => {
    const base = await seedDraft(w, { signers: [{ email: 'p@example.com', role: 'primary' }] });
    await addField(w, base.envelopeId, base.signerIds[0], 0);
    const { template_id } = await (await manage({ action: 'save_from_envelope', envelope_id: base.envelopeId, name: 'Soon gone' })).json();
    await w.q(`UPDATE public.esign_templates SET deleted_at = now() WHERE id = $1`, [template_id]);
    const gone = await manage({ action: 'apply_to_envelope', envelope_id: base.envelopeId, template_id });
    expect([gone.status, (await gone.json()).code]).toEqual([404, 'template_not_found']);
    await w.q(`UPDATE public.esign_envelopes SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1`, [base.envelopeId]);
    const sent = await manage({ action: 'apply_to_envelope', envelope_id: base.envelopeId, template_id });
    expect([sent.status, (await sent.json()).code]).toEqual([409, 'not_draft']);
  });

  it('refuses a missing name and an unknown action', async () => {
    const res = await manage({ action: 'save_from_envelope', envelope_id: randomUUID(), name: '  ' });
    expect((await res.json()).code).toBe('invalid_name');
    expect((await manage({ action: 'list' })).status).toBe(400);
  });
});
