// @vitest-environment node
// esign-verify-document: a completed envelope's digest verifies, a deleted one answers from
// its tombstone, anything else is not verified in words that accuse no one.
import { beforeAll, describe, expect, it } from 'vitest';
import { createVerifyDocumentHandler, NOT_VERIFIED_REASON, type VerifyDocumentDeps } from '../../../supabase/functions/esign-verify-document/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, ORIGINS, seedContact, seedSentEnvelope, type World } from './esign-world';

let w: World;

function deps(over: Partial<VerifyDocumentDeps> = {}): VerifyDocumentDeps {
  return { allowedOrigins: ORIGINS, db: w.db, rateLimit: async () => 'allowed', logSink: w.logSink, ...over };
}

const check = (sha256: unknown, d = deps()) => createVerifyDocumentHandler(d)(edgeRequest({ body: { sha256 } }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-verify-document', () => {
  describeEdgeContract({
    name: 'esign-verify-document',
    get handler() {
      return createVerifyDocumentHandler(deps());
    },
    get failingHandler() {
      return createVerifyDocumentHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createVerifyDocumentHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { sha256: 'f'.repeat(64) }, maxBytes: 4_096 },
  });

  it('verifies a completed envelope by its digest, with names and statuses', async () => {
    const contactId = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    const { envelopeId } = await seedSentEnvelope(w, { title: 'Lease', signers: [{ email: 'ada@example.com', contactId }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = '2030-01-02T00:00:00Z' WHERE envelope_id = $1`, [envelopeId]);
    await w.q(`UPDATE public.esign_envelopes SET status = 'completed', completed_at = '2030-01-02T00:00:00Z', signed_pdf_sha256 = $2 WHERE id = $1`, [envelopeId, 'b'.repeat(64)]);
    const res = await check('B'.repeat(64));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      verified: true,
      title: 'Lease',
      completed_at: expect.toSatisfy((v: string) => Date.parse(v) === Date.parse('2030-01-02T00:00:00Z')),
      sha256: 'b'.repeat(64),
      signers: [
        { name: 'Ada Lovelace', status: 'signed', signed_at: expect.toSatisfy((v: string) => Date.parse(v) === Date.parse('2030-01-02T00:00:00Z')) },
        { name: 'alan@example.com', status: 'signed', signed_at: expect.toSatisfy((v: string) => Date.parse(v) === Date.parse('2030-01-02T00:00:00Z')) },
      ],
    });
  });

  it('answers a deleted envelope from its tombstone', async () => {
    await w.q(
      `INSERT INTO public.esign_completed_tombstones (envelope_id, title, completed_at, signed_pdf_sha256, signers)
       VALUES (gen_random_uuid(), 'Old lease', '2029-05-01T00:00:00Z', $1, '[{"name": "Grace Hopper", "email": "grace@example.com", "status": "signed", "signed_at": "2029-05-01T00:00:00Z"}, {"email": "x@example.com"}]')`,
      ['c'.repeat(64)],
    );
    expect(await (await check('c'.repeat(64))).json()).toEqual({
      verified: true,
      title: 'Old lease',
      completed_at: expect.toSatisfy((v: string) => Date.parse(v) === Date.parse('2029-05-01T00:00:00Z')),
      sha256: 'c'.repeat(64),
      signers: [
        { name: 'Grace Hopper', status: 'signed', signed_at: '2029-05-01T00:00:00Z' },
        { name: 'x@example.com', status: 'signed', signed_at: null },
      ],
    });
  });

  it('does not verify an unknown digest, or the digest of an envelope still in progress', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    // A signed digest on an envelope that is not completed: only completion makes it a record.
    await w.q(`UPDATE public.esign_envelopes SET signed_pdf_sha256 = $2 WHERE id = $1`, [envelopeId, 'd'.repeat(64)]);
    for (const sha of ['d'.repeat(64), 'e'.repeat(64)]) {
      expect(await (await check(sha)).json()).toEqual({ verified: false, reason: NOT_VERIFIED_REASON, sha256: sha });
    }
    expect(NOT_VERIFIED_REASON).not.toMatch(/forg|fraud|tamper/i);
  });

  it('refuses a malformed digest, and a body that is not JSON by type', async () => {
    for (const sha of ['abc', 'g'.repeat(64), 42]) expect((await check(sha)).status).toBe(400);
    const form = await createVerifyDocumentHandler(deps())(
      edgeRequest({ headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ sha256: 'a'.repeat(64) }) }),
    );
    expect(form.status).toBe(415);
    expect((await form.json()).code).toBe('unsupported_media_type');
  });
});
