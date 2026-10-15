// @vitest-environment node
// esign-expire-envelopes: past-deadline envelopes expire children first (a fully signed
// one is finalized instead), retention clears working files 90 days after the end, and
// the owner gets one summary.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExpireEnvelopesHandler, type ExpireEnvelopesDeps } from '../../../supabase/functions/esign-expire-envelopes/handler';
import { CREDENTIALS, CRON_SECRET, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { createWorld, drawnSignaturePng, ORIGINS, OWNER_EMAIL, seedContact, seedSentEnvelope, SITE_URL, withRace, type World } from './esign-world';

let w: World;
let finalized: string[] = [];

function deps(over: Partial<ExpireEnvelopesDeps> = {}): ExpireEnvelopesDeps {
  return {
    allowedOrigins: ORIGINS,
    cronSecret: CRON_SECRET,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    storage: w.storage,
    finalize: async (id) => {
      finalized.push(id);
      return true;
    },
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    ownerEmail: async () => OWNER_EMAIL,
    siteUrl: SITE_URL,
    logSink: w.logSink,
    ...over,
  };
}

const run = async (d = deps()) => {
  const res = await createExpireEnvelopesHandler(d)(edgeRequest({ origin: null, headers: CREDENTIALS.cron }));
  expect(res.status).toBe(200);
  return res.json();
};

const pastDeadline = (id: string) => w.q(`UPDATE public.esign_envelopes SET expires_at = now() - interval '1 hour' WHERE id = $1`, [id]);

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

beforeEach(async () => {
  finalized = [];
  // Each test starts with nothing due.
  await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE status IN ('sent', 'partially_signed')`);
});

describe('esign-expire-envelopes', () => {
  describeEdgeContract({
    name: 'esign-expire-envelopes',
    get handler() {
      return createExpireEnvelopesHandler(deps());
    },
    get failingHandler() {
      return createExpireEnvelopesHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.cron,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'optional_json' },
  });

  it('the owner may run it too', async () => {
    const res = await createExpireEnvelopesHandler(deps())(edgeRequest({ headers: CREDENTIALS.owner }));
    expect(res.status).toBe(200);
  });

  it('expires a past-deadline envelope: waiting signers, pending tasks, then the envelope, and tells the owner once', async () => {
    const contactId = await seedContact(w, { email: 'ada@example.com' });
    const { envelopeId, signers } = await seedSentEnvelope(w, { title: 'Lease', status: 'partially_signed', signers: [{ email: 'ada@example.com', contactId }, { email: 'alan@example.com' }] });
    const [task] = await w.q<{ id: string }>(`INSERT INTO public.client_tasks (contact_id, title, type) VALUES ($1, 'Sign: Lease', 'esign') RETURNING id`, [contactId]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[0].id, task.id]);
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[1].id]);
    await pastDeadline(envelopeId);
    const before = w.emails.length;

    const out = await run();
    expect(out).toMatchObject({ ok: true, expired: 1, signers_expired: 1, tasks_dismissed: 1, finalize_redriven: 0 });
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('expired');
    const rows = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = $1 ORDER BY "order"`, [envelopeId]);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'signed']);
    const [t] = await w.q<{ status: string }>(`SELECT status FROM public.client_tasks WHERE id = $1`, [task.id]);
    expect(t.status).toBe('dismissed');
    const mails = w.emails.slice(before);
    expect(mails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(mails[0].text).toContain('Lease (1 signer had not signed)');
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_events WHERE envelope_id = $1 AND event_type = 'envelope_expired'`, [envelopeId])).toHaveLength(1);

    // A rerun finds nothing and sends nothing.
    expect(await run()).toMatchObject({ expired: 0 });
    expect(w.emails.length).toBe(before + 1);
  });

  it('finalizes a fully signed envelope instead of expiring it, one per run', async () => {
    const a = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const b = await seedSentEnvelope(w, { signers: [{ email: 'alan@example.com' }] });
    for (const e of [a, b]) {
      await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE envelope_id = $1`, [e.envelopeId]);
      await pastDeadline(e.envelopeId);
    }
    const out = await run();
    expect(out).toMatchObject({ expired: 0, finalize_redriven: 1, finalize_deferred: 1 });
    expect(finalized).toHaveLength(1);
    const statuses = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = ANY($1::uuid[])`, [[a.envelopeId, b.envelopeId]]);
    expect(statuses.map((s) => s.status)).toEqual(['sent', 'sent']);
  });

  it('leaves alone an envelope whose deadline has not passed', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    expect(await run()).toMatchObject({ expired: 0 });
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('sent');
  });

  it('does not overwrite an envelope that ended another way meanwhile', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await pastDeadline(envelopeId);
    // A decline lands between the read and the flip (a completion is also refused by the freeze trigger).
    const racing = withRace(w, 'esign_envelopes', (v) => v.status === 'expired', `UPDATE public.esign_envelopes SET status = 'declined' WHERE id = $1`, [envelopeId]);
    expect(await run(deps({ db: racing }))).toMatchObject({ expired: 0 });
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('declined');
  });

  it('purges working files and drawn images 90 days after each kind of end, and only then', async () => {
    const ended: Record<string, string> = {};
    // Only each status's own moment is old: the others are recent, so a sweep aging a
    // status by the wrong column would miss it.
    for (const status of ['completed', 'voided', 'expired', 'declined']) {
      const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
      await w.q(`INSERT INTO public.esign_signer_signature_images (signer_id, image_base64) VALUES ($1, $2)`, [signers[0].id, await drawnSignaturePng()]);
      await w.q(`ALTER TABLE public.esign_envelopes DISABLE TRIGGER USER`);
      await w.q(
        `UPDATE public.esign_envelopes SET status = $2,
           completed_at = CASE WHEN $2 = 'completed' THEN now() - interval '91 days' ELSE now() END,
           voided_at = CASE WHEN $2 = 'voided' THEN now() - interval '91 days' ELSE now() END,
           expires_at = CASE WHEN $2 = 'expired' THEN now() - interval '91 days' ELSE now() END,
           updated_at = CASE WHEN $2 = 'declined' THEN now() - interval '91 days' ELSE now() END
         WHERE id = $1`,
        [envelopeId, status],
      );
      await w.q(`ALTER TABLE public.esign_envelopes ENABLE TRIGGER USER`);
      ended[status] = envelopeId;
    }
    const recent = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() - interval '89 days' WHERE id = $1`, [recent.envelopeId]);

    const out = await run();
    expect(out.working_envelopes_purged).toBe(4);
    expect(out.working_objects_removed).toBe(8);
    for (const id of Object.values(ended)) {
      expect([...w.storage.working.keys()].some((k) => k.startsWith(id))).toBe(false);
      const [env] = await w.q<{ p: string | null }>(`SELECT source_pdf_path AS p FROM public.esign_envelopes WHERE id = $1`, [id]);
      expect(env.p).toBeNull();
      expect(await w.q(`SELECT 1 FROM public.esign_signer_signature_images i JOIN public.esign_envelope_signers s ON s.id = i.signer_id WHERE s.envelope_id = $1`, [id])).toEqual([]);
    }
    expect(w.storage.working.has(`${recent.envelopeId}/source.pdf`)).toBe(true);
    expect((await run()).working_envelopes_purged).toBe(0);
  });

  it('skips an envelope whose listing failed, keeping its source path for the next run', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() - interval '100 days' WHERE id = $1`, [envelopeId]);
    w.storage.fail.add('listWorking');
    try {
      expect((await run()).working_envelopes_purged).toBe(0);
    } finally {
      w.storage.fail.delete('listWorking');
    }
    const [env] = await w.q<{ p: string | null }>(`SELECT source_pdf_path AS p FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.p).not.toBeNull();
  });

  it('prunes old codes and sessions', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(
      `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at) VALUES ($1, repeat('0', 64), '0123', now(), now() - interval '31 days')`,
      [signers[0].id],
    );
    await w.q(`INSERT INTO public.esign_signer_sessions (signer_id, session_token_hash, expires_at, ip) VALUES ($1, repeat('1', 64), now() - interval '2 days', '203.0.113.5')`, [signers[0].id]);
    expect(await run()).toMatchObject({ sms_codes_deleted: 1, sessions_deleted: 1 });
  });
});
