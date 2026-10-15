// @vitest-environment node
// esign-void-envelope: the guarded void, waiting signers expired, only pending tasks of
// signers who had not signed dismissed, and the notices.
import { beforeAll, describe, expect, it } from 'vitest';
import { createVoidEnvelopeHandler, type VoidEnvelopeDeps } from '../../../supabase/functions/esign-void-envelope/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { createWorld, ORIGINS, OWNER_EMAIL, seedContact, seedSentEnvelope, withRace, type World } from './esign-world';

let w: World;

function deps(over: Partial<VoidEnvelopeDeps> = {}): VoidEnvelopeDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    ownerEmail: async () => OWNER_EMAIL,
    logSink: w.logSink,
    ...over,
  };
}

const voidIt = (body: unknown, d = deps()) => createVoidEnvelopeHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

async function task(contactId: string, status = 'pending'): Promise<string> {
  const [t] = await w.q<{ id: string }>(
    `INSERT INTO public.client_tasks (contact_id, title, type, status, completed_at) VALUES ($1, 'Sign: Letter', 'esign', $2, CASE WHEN $2 = 'completed' THEN now() END) RETURNING id`,
    [contactId, status],
  );
  return t.id;
}

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-void-envelope', () => {
  describeEdgeContract({
    name: 'esign-void-envelope',
    get handler() {
      return createVoidEnvelopeHandler(deps());
    },
    get failingHandler() {
      return createVoidEnvelopeHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 16_384 },
  });

  it('voids, expires waiting signers, dismisses only the unsigned pending tasks and tells the right people', async () => {
    const ada = await seedContact(w, { email: 'ada@example.com' });
    const alan = await seedContact(w, { email: 'alan@example.com', first_name: 'Alan', last_name: 'Turing' });
    const { envelopeId, signers } = await seedSentEnvelope(w, {
      status: 'partially_signed',
      signers: [{ email: 'ada@example.com', contactId: ada }, { email: 'alan@example.com', contactId: alan }],
    });
    const signedTask = await task(ada, 'completed');
    const waitingTask = await task(alan);
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), client_task_id = $2 WHERE id = $1`, [signers[0].id, signedTask]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[1].id, waitingTask]);

    const before = w.emails.length;
    const res = await voidIt({ envelope_id: envelopeId, void_reason: '  Wrong\u0000 version  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signers_voided: 1, tasks_dismissed: 1 });

    const [env] = await w.q<{ status: string; void_reason: string; voided_at: string | null }>(`SELECT status, void_reason, voided_at FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env).toMatchObject({ status: 'voided', void_reason: 'Wrong version' });
    expect(env.voided_at).not.toBeNull();
    const rows = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = $1 ORDER BY "order"`, [envelopeId]);
    expect(rows.map((r) => r.status)).toEqual(['signed', 'expired']);
    const tasks = await w.q<{ id: string; status: string }>(`SELECT id, status FROM public.client_tasks WHERE id = ANY($1::uuid[])`, [[signedTask, waitingTask]]);
    expect(Object.fromEntries(tasks.map((t) => [t.id, t.status]))).toEqual({ [signedTask]: 'completed', [waitingTask]: 'dismissed' });

    const sent = w.emails.slice(before);
    expect(sent.map((m) => m.to)).toEqual(['alan@example.com', OWNER_EMAIL]);
    expect(sent[0].html).toContain('Alan Turing');
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
    const events = await w.q<{ event_type: string; metadata: Record<string, unknown> }>(`SELECT event_type, metadata FROM public.esign_envelope_events WHERE envelope_id = $1`, [envelopeId]);
    expect(events).toEqual([{ event_type: 'envelope_voided', metadata: expect.objectContaining({ void_reason: 'Wrong version', signers_voided: 1 }) }]);
  });

  it('refuses an envelope that is not live, and loses to a completion that landed first', async () => {
    const done = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelopes SET status = 'expired' WHERE id = $1`, [done.envelopeId]);
    const res = await voidIt({ envelope_id: done.envelopeId });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_live');

    const live = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = withRace(w, 'esign_envelopes', (v) => v.status === 'voided', `UPDATE public.esign_envelopes SET status = 'declined' WHERE id = $1`, [live.envelopeId]);
    const raced = await voidIt({ envelope_id: live.envelopeId }, deps({ db: racing }));
    expect(raced.status).toBe(409);
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [live.envelopeId]);
    expect(env.status).toBe('declined');
    const [s] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = $1`, [live.envelopeId]);
    expect(s.status).toBe('invited');
  });

  it('leaves a signed signer’s task and a finished task alone, whatever their state', async () => {
    const ada = await seedContact(w, { email: 'ada@example.com' });
    const alan = await seedContact(w, { email: 'alan@example.com' });
    const { envelopeId, signers } = await seedSentEnvelope(w, {
      status: 'partially_signed',
      signers: [{ email: 'ada@example.com', contactId: ada }, { email: 'alan@example.com', contactId: alan }],
    });
    // A signer who signed but whose task is still pending, and a waiting signer whose task is already done.
    const signedPending = await task(ada);
    const waitingDone = await task(alan, 'completed');
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), client_task_id = $2 WHERE id = $1`, [signers[0].id, signedPending]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[1].id, waitingDone]);
    expect(await (await voidIt({ envelope_id: envelopeId })).json()).toMatchObject({ tasks_dismissed: 0 });
    const tasks = await w.q<{ id: string; status: string }>(`SELECT id, status FROM public.client_tasks WHERE id = ANY($1::uuid[])`, [[signedPending, waitingDone]]);
    expect(Object.fromEntries(tasks.map((t) => [t.id, t.status]))).toEqual({ [signedPending]: 'pending', [waitingDone]: 'completed' });
  });

  it('refuses a reason over 500 characters or not text', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    for (const void_reason of ['x'.repeat(501), 7]) {
      const res = await voidIt({ envelope_id: envelopeId, void_reason });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_reason');
    }
  });

  it('is void even when the notices cannot be sent', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const res = await voidIt({ envelope_id: envelopeId }, deps({ sendEmail: async () => { throw new Error('provider down'); } }));
    expect(res.status).toBe(200);
  });
});
