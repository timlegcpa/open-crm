// @vitest-environment node
// esign-portal-signer-token: the addressee gate, the terminal states, the guarded rotation.
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createPortalSignerTokenHandler, type PortalSignerTokenDeps } from '../../../supabase/functions/esign-portal-signer-token/handler';
import { CLIENT_USER_ID, CREDENTIALS, describeEdgeContract, edgeRequest, fakeClientAuth, throwInternal } from './contract';
import { createWorld, ORIGINS, seedSentEnvelope, withRace, type World } from './esign-world';

let w: World;
let loginEmail: string | null = 'ada@example.com';

function deps(over: Partial<PortalSignerTokenDeps> = {}): PortalSignerTokenDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeClient: fakeClientAuth(),
    db: w.db,
    userEmail: async () => loginEmail,
    rateLimit: async () => 'allowed',
    logSink: w.logSink,
    ...over,
  };
}

const exchange = (signerId: unknown, d = deps()) =>
  createPortalSignerTokenHandler(d)(edgeRequest({ headers: CREDENTIALS.client, body: { signer_id: signerId } }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-portal-signer-token', () => {
  describeEdgeContract({
    name: 'esign-portal-signer-token',
    get handler() {
      return createPortalSignerTokenHandler(deps());
    },
    get failingHandler() {
      return createPortalSignerTokenHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.client,
    wrongPrincipal: CREDENTIALS.owner,
    clientWrites: true,
    body: { kind: 'json', valid: { signer_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 4_096 },
  });

  it('limits per user', async () => {
    let seen: string | undefined;
    const res = await exchange('10000000-0000-4000-8000-0000000000e1', deps({ rateLimit: async (p) => { seen = p.userId; return 'limited'; } }));
    expect(res.status).toBe(429);
    expect(seen).toBe(CLIENT_USER_ID);
  });

  it('rotates the link for the addressee and kills the old one', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    loginEmail = 'ADA@example.com';
    const res = await exchange(signers[0].id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('ok');
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [s] = await w.q<{ token_hash: string }>(`SELECT token_hash FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.token_hash).toBe(await sha256Hex(body.token));
    expect(s.token_hash).not.toBe(await sha256Hex(signers[0].token));
    loginEmail = 'ada@example.com';
  });

  it('refuses a login whose address is not the one the request went to', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'byron@example.com' }] });
    const res = await exchange(signers[1].id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('wrong_addressee');
    loginEmail = null;
    expect((await exchange(signers[0].id)).status).toBe(403);
    loginEmail = 'ada@example.com';
  });

  it('answers terminal states without rotating, and 404 for an unknown signer', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { title: 'Lease', signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
    expect(await (await exchange(signers[0].id)).json()).toEqual({ state: 'voided', envelope: { title: 'Lease' } });
    const [s] = await w.q<{ token_hash: string }>(`SELECT token_hash FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.token_hash).toBe(await sha256Hex(signers[0].token));
    expect((await exchange('10000000-0000-4000-8000-00000000dead')).status).toBe(404);
    expect((await exchange('nope')).status).toBe(404);
  });

  it('does not rotate a signer who signed between the read and the write', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = withRace(w, 'esign_envelope_signers', (v) => 'token_hash' in v, `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    expect((await exchange(signers[0].id, deps({ db: racing }))).status).toBe(404);
    const [s] = await w.q<{ token_hash: string }>(`SELECT token_hash FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.token_hash).toBe(await sha256Hex(signers[0].token));
  });
});
