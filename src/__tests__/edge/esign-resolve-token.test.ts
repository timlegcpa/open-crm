// @vitest-environment node
// esign-resolve-token: an unknown token is one 404; a token its holder owns answers its
// state; a usable one answers the fields and page count and is logged every time.
import { beforeAll, describe, expect, it } from 'vitest';
import { createResolveTokenHandler, type ResolveTokenDeps } from '../../../supabase/functions/esign-resolve-token/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, ORIGINS, seedContact, seedSentEnvelope, type World } from './esign-world';

let w: World;

function deps(over: Partial<ResolveTokenDeps> = {}): ResolveTokenDeps {
  return { allowedOrigins: ORIGINS, db: w.db, rateLimit: async () => 'allowed', logSink: w.logSink, ...over };
}

const resolve = (token: unknown, d = deps()) =>
  createResolveTokenHandler(d)(edgeRequest({ headers: { 'User-Agent': 'Test agent' }, body: { token } }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-resolve-token', () => {
  describeEdgeContract({
    name: 'esign-resolve-token',
    get handler() {
      return createResolveTokenHandler(deps());
    },
    get failingHandler() {
      return createResolveTokenHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createResolveTokenHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, maxBytes: 4_096 },
  });

  it('answers the signer, fields and page count, stamps the first open and logs every open', async () => {
    const contactId = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', spouse_email: 'byron@example.com', spouse_first_name: 'Byron', spouse_last_name: 'Lord' });
    const { envelopeId, signers } = await seedSentEnvelope(w, {
      title: 'Lease',
      signers: [{ email: 'ada@example.com', contactId, role: 'primary' }, { email: 'byron@example.com', contactId, role: 'co_signer' }],
    });
    const res = await resolve(signers[1].token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: 'ok',
      envelope: { id: envelopeId, title: 'Lease', verification_level: 'standard', status: 'sent' },
      signer: { id: signers[1].id, first_name: 'Byron', last_name: 'Lord', email: 'byron@example.com', status: 'invited', signed_at: null, phone_last_four: null },
      document: { page_count: 2 },
      fields: [{ id: expect.any(String), page_index: 0, field_type: 'signature', x: 50, y: 100, width: 200, height: 40 }],
      needs_sms: false,
    });
    const [first] = await w.q<{ opened_email_at: string }>(`SELECT opened_email_at::text FROM public.esign_envelope_signers WHERE id = $1`, [signers[1].id]);
    expect(first.opened_email_at).not.toBeNull();
    await resolve(signers[1].token);
    const [again] = await w.q<{ opened_email_at: string }>(`SELECT opened_email_at::text FROM public.esign_envelope_signers WHERE id = $1`, [signers[1].id]);
    expect(again.opened_email_at).toBe(first.opened_email_at);
    const events = await w.q<{ event_type: string; user_agent: string }>(`SELECT event_type, user_agent FROM public.esign_envelope_events WHERE signer_id = $1`, [signers[1].id]);
    expect(events).toEqual([
      { event_type: 'signer_opened_link', user_agent: 'Test agent' },
      { event_type: 'signer_opened_link', user_agent: 'Test agent' },
    ]);
  });

  it('answers a signer with no linked contact, by address alone', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'alan@example.com' }] });
    const body = await (await resolve(signers[0].token)).json();
    expect(body.signer).toMatchObject({ first_name: null, last_name: null, email: 'alan@example.com' });
  });

  it('names each terminal state, declines ahead of the expiry they cause', async () => {
    const make = async () => (await seedSentEnvelope(w, { title: 'Lease', signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] }));
    const cases: Array<[string, (e: Awaited<ReturnType<typeof make>>) => Promise<unknown>, number]> = [
      ['already_signed', (e) => w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [e.signers[0].id]), 0],
      ['declined', (e) => w.q(`UPDATE public.esign_envelope_signers SET status = 'declined' WHERE id = $1`, [e.signers[0].id]), 0],
      [
        'co_signer_declined',
        async (e) => {
          await w.q(`UPDATE public.esign_envelopes SET status = 'declined' WHERE id = $1`, [e.envelopeId]);
          await w.q(`UPDATE public.esign_envelope_signers SET status = 'expired' WHERE id = $1`, [e.signers[1].id]);
        },
        1,
      ],
      ['voided', (e) => w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [e.envelopeId]), 0],
      ['expired', (e) => w.q(`UPDATE public.esign_envelope_signers SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [e.signers[0].id]), 0],
    ];
    for (const [state, apply, who] of cases) {
      const e = await make();
      await apply(e);
      const res = await resolve(e.signers[who].token);
      expect([state, res.status]).toEqual([state, 200]);
      const body = await res.json();
      expect(body).toEqual({ state, envelope: { title: 'Lease' }, signer: { first_name: null, last_name: null, email: who === 0 ? 'ada@example.com' : 'alan@example.com' } });
    }
  });

  it('answers one 404 for an unknown token, a malformed one, and a pending signer', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'pending' WHERE id = $1`, [signers[0].id]);
    for (const token of ['unknown-token-0123456789abcdef', 'short', 42, signers[0].token]) {
      const res = await resolve(token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'This signing link is not valid.', code: 'not_found' });
    }
  });

  it("tells the page a 'high' envelope needs the code", async () => {
    const { signers } = await seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    const body = await (await resolve(signers[0].token)).json();
    expect(body.needs_sms).toBe(true);
    expect(body.signer.phone_last_four).toBe('0123');
  });
});
