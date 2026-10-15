// @vitest-environment node
// esign-delete-envelope: the force question first, the complete working folder, the
// tombstone before the cascade, the executed copy left alone, and the audit row.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDeleteEnvelopeHandler, type DeleteEnvelopeDeps } from '../../../supabase/functions/esign-delete-envelope/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { createWorld, ORIGINS, seedContact, seedSentEnvelope, type World } from './esign-world';

let w: World;
const SHA = 'a'.repeat(64);

function deps(over: Partial<DeleteEnvelopeDeps> = {}): DeleteEnvelopeDeps {
  return { allowedOrigins: ORIGINS, authorizeOwner: fakeOwnerAuth(), db: w.db, storage: w.storage, audit: w.audit, logSink: w.logSink, ...over };
}

const del = (body: unknown, d = deps()) => createDeleteEnvelopeHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

async function completed() {
  const contactId = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
  const seeded = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com', contactId, role: 'primary' }], primaryContactId: contactId });
  await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_text = 'Ada Lovelace', signed_font = 'allison' WHERE envelope_id = $1`, [seeded.envelopeId]);
  await w.q(`INSERT INTO public.esign_envelope_events (envelope_id, signer_id, event_type) VALUES ($1, $2, 'signer_signed'), ($1, NULL, 'envelope_completed')`, [seeded.envelopeId, seeded.signers[0].id]);
  await w.q(
    `UPDATE public.esign_envelopes SET status = 'completed', completed_at = now(), signed_pdf_path = $2, signed_pdf_sha256 = $3 WHERE id = $1`,
    [seeded.envelopeId, `${contactId}/esign/${seeded.envelopeId}.pdf`, SHA],
  );
  w.storage.documents.set(`${contactId}/esign/${seeded.envelopeId}.pdf`, new Uint8Array([1, 2, 3]));
  return { ...seeded, contactId };
}

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-delete-envelope', () => {
  describeEdgeContract({
    name: 'esign-delete-envelope',
    get handler() {
      return createDeleteEnvelopeHandler(deps());
    },
    get failingHandler() {
      return createDeleteEnvelopeHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 16_384 },
  });

  it('deletes a live envelope with its working files and records the audit row', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    w.storage.working.set(`${envelopeId}/sources/deep/extra.pdf`, new Uint8Array([9]));
    const res = await del({ envelope_id: envelopeId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope_id: envelopeId, working_objects_removed: 3 });
    expect([...w.storage.working.keys()].filter((k) => k.startsWith(envelopeId))).toEqual([]);
    expect(await w.q(`SELECT 1 FROM public.esign_envelopes WHERE id = $1`, [envelopeId])).toEqual([]);
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_signers WHERE envelope_id = $1`, [envelopeId])).toEqual([]);
    const [audit] = await w.q<{ action: string; details: Record<string, unknown>; user_id: string }>(
      `SELECT action, details, user_id FROM public.audit_logs WHERE details->>'envelope_id' = $1`,
      [envelopeId],
    );
    expect(audit).toEqual({
      action: 'esign_envelope_deleted',
      user_id: OWNER_ID,
      details: { envelope_id: envelopeId, status: 'sent', working_objects_removed: 3, signed_pdf_sha256: null, tombstoned: false },
    });
  });

  it('asks before deleting a completed envelope, and touches nothing when asked', async () => {
    const { envelopeId } = await completed();
    const res = await del({ envelope_id: envelopeId });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('requires_force');
    expect(w.storage.working.has(`${envelopeId}/source.pdf`)).toBe(true);
    expect(await w.q(`SELECT 1 FROM public.esign_envelopes WHERE id = $1`, [envelopeId])).toHaveLength(1);
  });

  it('with force, tombstones the completed envelope first and keeps the executed copy', async () => {
    const { envelopeId, contactId, signers } = await completed();
    const res = await del({ envelope_id: envelopeId, force: true });
    expect(res.status).toBe(200);
    const [tomb] = await w.q<{ title: string; signed_pdf_sha256: string; signers: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; deleted_by: string }>(
      `SELECT title, signed_pdf_sha256, signers, events, deleted_by FROM public.esign_completed_tombstones WHERE envelope_id = $1`,
      [envelopeId],
    );
    expect(tomb.signed_pdf_sha256).toBe(SHA);
    expect(tomb.deleted_by).toBe(OWNER_ID);
    expect(tomb.signers).toEqual([expect.objectContaining({ id: signers[0].id, name: 'Ada Lovelace', email: 'ada@example.com', status: 'signed' })]);
    expect(tomb.events.map((e) => e.event_type).sort()).toEqual(['envelope_completed', 'signer_signed']);
    expect(w.storage.documents.has(`${contactId}/esign/${envelopeId}.pdf`)).toBe(true);
    const [audit] = await w.q<{ details: Record<string, unknown> }>(`SELECT details FROM public.audit_logs WHERE details->>'envelope_id' = $1`, [envelopeId]);
    expect(audit.details).toMatchObject({ status: 'completed', tombstoned: true, signed_pdf_sha256: SHA });
  });

  it('aborts on a partial listing, with the envelope still there', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    w.storage.fail.add('listWorking');
    try {
      expect((await del({ envelope_id: envelopeId })).status).toBe(500);
    } finally {
      w.storage.fail.delete('listWorking');
    }
    expect(await w.q(`SELECT 1 FROM public.esign_envelopes WHERE id = $1`, [envelopeId])).toHaveLength(1);
    expect(w.storage.working.has(`${envelopeId}/source.pdf`)).toBe(true);
  });

  it('without force, will not delete an envelope that completed during the delete', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE envelope_id = $1`, [envelopeId]);
    // The completion lands as the images are cleared, just before the row delete.
    const racing = {
      from: (t: string) => w.db.from(t),
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'esign_delete_signature_images_for_envelope') {
          await w.q(`UPDATE public.esign_envelopes SET status = 'completed', completed_at = now(), signed_pdf_sha256 = $2 WHERE id = $1`, [envelopeId, SHA]);
        }
        return w.db.rpc(fn, args);
      },
    };
    const res = await del({ envelope_id: envelopeId }, deps({ db: racing }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('conflict');
    expect(await w.q(`SELECT 1 FROM public.esign_envelopes WHERE id = $1`, [envelopeId])).toHaveLength(1);
  });

  it('answers 404 for an unknown envelope and 400 for a malformed id', async () => {
    expect((await del({ envelope_id: '10000000-0000-4000-8000-00000000dead' })).status).toBe(404);
    expect((await del({ envelope_id: 'nope' })).status).toBe(400);
  });
});
