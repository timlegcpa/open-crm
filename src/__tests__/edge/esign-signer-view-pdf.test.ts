// @vitest-environment node
// esign-signer-view-pdf: the exact assembled bytes, first consent recorded once, the
// guarded first-view advance, and the SMS session for 'high'.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSignerViewPdfHandler, type SignerViewPdfDeps } from '../../../supabase/functions/esign-signer-view-pdf/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, openSession, ORIGINS, seedSentEnvelope, SIGNER_IP, withRace, type World } from './esign-world';

let w: World;

function deps(over: Partial<SignerViewPdfDeps> = {}): SignerViewPdfDeps {
  return { allowedOrigins: ORIGINS, db: w.db, storage: w.storage, rateLimit: async () => 'allowed', logSink: w.logSink, ...over };
}

const view = (body: Record<string, unknown>, d = deps(), ip = SIGNER_IP) =>
  createSignerViewPdfHandler(d)(edgeRequest({ headers: { 'cf-connecting-ip': ip }, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-signer-view-pdf', () => {
  describeEdgeContract({
    name: 'esign-signer-view-pdf',
    get handler() {
      return createSignerViewPdfHandler(deps());
    },
    get failingHandler() {
      return createSignerViewPdfHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createSignerViewPdfHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, maxBytes: 8_192 },
  });

  it('answers the source PDF, records the first consent once, and advances the first view', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const res = await view({ token: signers[0].token, consent: true, consent_version: 'v1.0' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(w.storage.working.get(`${envelopeId}/source.pdf`));

    const [s] = await w.q<{ status: string; consented_at: string; v: string; first_viewed_at: string }>(
      `SELECT status, consented_at::text, consent_disclosure_version AS v, first_viewed_at::text FROM public.esign_envelope_signers WHERE id = $1`,
      [signers[0].id],
    );
    expect(s.status).toBe('viewed');
    expect(s.v).toBe('v1.0');

    await view({ token: signers[0].token, consent: true, consent_version: 'v2.0' });
    const [again] = await w.q<{ consented_at: string; v: string; first_viewed_at: string }>(
      `SELECT consented_at::text, consent_disclosure_version AS v, first_viewed_at::text FROM public.esign_envelope_signers WHERE id = $1`,
      [signers[0].id],
    );
    expect(again).toEqual({ consented_at: s.consented_at, v: 'v1.0', first_viewed_at: s.first_viewed_at });
    const events = await w.q<{ event_type: string }>(`SELECT event_type FROM public.esign_envelope_events WHERE signer_id = $1 ORDER BY event_type`, [signers[0].id]);
    expect(events.map((e) => e.event_type)).toEqual(['consent_accepted', 'signer_viewed_pdf']);
  });

  it('records a version outside the charset as none', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await view({ token: signers[0].token, consent: true, consent_version: 'v1 <script>' });
    const [s] = await w.q<{ v: string | null; c: boolean }>(`SELECT consent_disclosure_version AS v, consented_at IS NOT NULL AS c FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s).toEqual({ v: null, c: true });
  });

  it('keeps a consent another request recorded first', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = withRace(w, 'esign_envelope_signers', (v) => 'consented_at' in v, `UPDATE public.esign_envelope_signers SET consented_at = '2030-01-01T00:00:00Z', consent_disclosure_version = 'v0.5' WHERE id = $1`, [signers[0].id]);
    expect((await view({ token: signers[0].token, consent: true, consent_version: 'v1.0' }, deps({ db: racing }))).status).toBe(200);
    const [s] = await w.q<{ v: string }>(`SELECT consent_disclosure_version AS v FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.v).toBe('v0.5');
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_events WHERE signer_id = $1 AND event_type = 'consent_accepted'`, [signers[0].id])).toEqual([]);
  });

  it('never sets a signer who signed meanwhile back to viewed', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = withRace(w, 'esign_envelope_signers', (v) => v.status === 'viewed', `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    expect((await view({ token: signers[0].token }, deps({ db: racing }))).status).toBe(200);
    const [s] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.status).toBe('signed');
  });

  it("requires the session on a 'high' envelope, from the same address", async () => {
    const { signers } = await seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    const session = await openSession(w, signers[0].id);
    expect((await view({ token: signers[0].token })).status).toBe(401);
    expect((await view({ token: signers[0].token, session_token: session }, deps(), '198.51.100.7')).status).toBe(401);
    expect((await view({ token: signers[0].token, session_token: 'x'.repeat(40) })).status).toBe(401);
    expect((await view({ token: signers[0].token, session_token: session })).status).toBe(200);
  });

  it('answers one 404 for a link that cannot be used', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    expect((await view({ token: signers[0].token })).status).toBe(404);
    await w.q(`UPDATE public.esign_envelopes SET status = 'expired' WHERE id = $1`, [envelopeId]);
    expect((await view({ token: signers[1].token })).status).toBe(404);
  });
});
