// @vitest-environment node
// esign-signer-decline: the guarded decline ends the envelope, other links die, unsigned
// pending tasks are dismissed, the owner hears, and a repeat finishes a half-done decline.
import { beforeAll, describe, expect, it } from 'vitest';
import { createSignerDeclineHandler, type SignerDeclineDeps } from '../../../supabase/functions/esign-signer-decline/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, openSession, ORIGINS, OWNER_EMAIL, seedContact, seedSentEnvelope, SIGNER_IP, SITE_URL, withRace, type World } from './esign-world';

let w: World;

function deps(over: Partial<SignerDeclineDeps> = {}): SignerDeclineDeps {
  return {
    allowedOrigins: ORIGINS,
    db: w.db,
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    ownerEmail: async () => OWNER_EMAIL,
    siteUrl: SITE_URL,
    rateLimit: async () => 'allowed',
    logSink: w.logSink,
    ...over,
  };
}

const decline = (body: Record<string, unknown>, d = deps()) =>
  createSignerDeclineHandler(d)(edgeRequest({ headers: { 'cf-connecting-ip': SIGNER_IP }, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-signer-decline', () => {
  describeEdgeContract({
    name: 'esign-signer-decline',
    get handler() {
      return createSignerDeclineHandler(deps());
    },
    get failingHandler() {
      return createSignerDeclineHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createSignerDeclineHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, maxBytes: 8_192 },
  });

  it('declines: envelope declined, siblings expired, unsigned tasks dismissed, the owner told', async () => {
    const ada = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    const alan = await seedContact(w, { email: 'alan@example.com' });
    const { envelopeId, signers } = await seedSentEnvelope(w, {
      title: 'Lease',
      signers: [{ email: 'ada@example.com', contactId: ada }, { email: 'alan@example.com', contactId: alan }, { email: 'grace@example.com' }],
    });
    const [adaTask] = await w.q<{ id: string }>(`INSERT INTO public.client_tasks (contact_id, title, type) VALUES ($1, 'Sign: Lease', 'esign') RETURNING id`, [ada]);
    const [alanTask] = await w.q<{ id: string }>(`INSERT INTO public.client_tasks (contact_id, title, type) VALUES ($1, 'Sign: Lease', 'esign') RETURNING id`, [alan]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[0].id, adaTask.id]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[1].id, alanTask.id]);
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[2].id]);

    const before = w.emails.length;
    const res = await decline({ token: signers[0].token, reason: ' Wrong\u0001 amount ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('declined');
    const rows = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = $1 ORDER BY "order"`, [envelopeId]);
    expect(rows.map((r) => r.status)).toEqual(['declined', 'expired', 'signed']);
    const tasks = await w.q<{ status: string }>(`SELECT status FROM public.client_tasks WHERE id = ANY($1::uuid[])`, [[adaTask.id, alanTask.id]]);
    expect(tasks.map((t) => t.status)).toEqual(['dismissed', 'dismissed']);
    const [ev] = await w.q<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM public.esign_envelope_events WHERE envelope_id = $1 AND event_type = 'signer_declined'`, [envelopeId]);
    expect(ev.metadata).toEqual({ reason: 'Wrong amount' });

    const alerts = w.emails.slice(before);
    expect(alerts.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(alerts[0].subject).toBe('Signer declined: Lease');
    expect(alerts[0].text).toContain('Ada Lovelace (ada@example.com)');
    expect(alerts[0].text).toContain(`${SITE_URL}/esign`);
  });

  it('answers a repeat as already declined and finishes a decline whose envelope write was lost', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'declined', token_expires_at = now() WHERE id = $1`, [signers[0].id]);
    expect(await (await decline({ token: signers[0].token })).json()).toEqual({ ok: true, already_declined: true });
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('declined');
  });

  it('refuses a signer who already signed, and a reason over 500 characters', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    const signed = await decline({ token: signers[0].token });
    expect(signed.status).toBe(409);
    expect((await signed.json()).code).toBe('already_signed');
    const long = await decline({ token: signers[1].token, reason: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect((await long.json()).code).toBe('invalid_reason');
  });

  it("requires the session on a 'high' envelope", async () => {
    const { signers } = await seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    expect((await decline({ token: signers[0].token })).status).toBe(401);
    const session = await openSession(w, signers[0].id);
    expect((await decline({ token: signers[0].token, session_token: session })).status).toBe(200);
  });

  it('loses to a signature that lands first', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = withRace(w, 'esign_envelope_signers', (v) => v.status === 'declined', `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    const res = await decline({ token: signers[0].token }, deps({ db: racing }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_signable');
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('sent');
  });
});
