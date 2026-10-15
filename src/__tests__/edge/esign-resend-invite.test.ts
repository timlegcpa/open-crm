// @vitest-environment node
// esign-resend-invite: a fresh link (the old one dies), a deadline that only moves out,
// a pending signer recovered, and the refusals.
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createResendInviteHandler, type ResendInviteDeps } from '../../../supabase/functions/esign-resend-invite/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { createWorld, ORIGINS, seedSentEnvelope, SITE_URL, type World } from './esign-world';

let w: World;
const NOW = new Date('2030-01-10T12:00:00Z');

function deps(over: Partial<ResendInviteDeps> = {}): ResendInviteDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    siteUrl: SITE_URL,
    now: () => NOW,
    logSink: w.logSink,
    ...over,
  };
}

const resend = (body: unknown, d = deps()) => createResendInviteHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-resend-invite', () => {
  describeEdgeContract({
    name: 'esign-resend-invite',
    get handler() {
      return createResendInviteHandler(deps());
    },
    get failingHandler() {
      return createResendInviteHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1', signer_id: '10000000-0000-4000-8000-0000000000e2' }, maxBytes: 16_384 },
  });

  it('replaces the link, extends both deadlines and logs invite_resent', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET token_expires_at = '2030-01-11T00:00:00Z' WHERE id = $1`, [signers[0].id]);
    await w.q(`UPDATE public.esign_envelopes SET expires_at = '2030-01-11T00:00:00Z' WHERE id = $1`, [envelopeId]);
    const before = w.emails.length;
    const res = await resend({ envelope_id: envelopeId, signer_id: signers[0].id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [s] = await w.q<{ token_hash: string; token_expires_at: string }>(
      `SELECT token_hash, to_char(token_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS token_expires_at FROM public.esign_envelope_signers WHERE id = $1`,
      [signers[0].id],
    );
    expect(s.token_hash).not.toBe(await sha256Hex(signers[0].token));
    expect(s.token_expires_at).toBe('2030-01-24T12:00:00');
    const [env] = await w.q<{ e: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS e FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.e).toBe('2030-01-24T12:00:00');

    const mail = w.emails[before];
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] as string;
    expect(await sha256Hex(token)).toBe(s.token_hash);
    const events = await w.q<{ event_type: string }>(`SELECT event_type FROM public.esign_envelope_events WHERE envelope_id = $1`, [envelopeId]);
    expect(events.map((e) => e.event_type)).toEqual(['invite_resent']);
  });

  it('never shortens a link that already lives longer', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET token_expires_at = '2031-01-01T00:00:00Z' WHERE id = $1`, [signers[0].id]);
    expect((await resend({ envelope_id: envelopeId, signer_id: signers[0].id })).status).toBe(200);
    const [s] = await w.q<{ y: string }>(`SELECT to_char(token_expires_at AT TIME ZONE 'UTC', 'YYYY') AS y FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.y).toBe('2031');
  });

  it('recovers a signer left pending by a failed first send', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'pending', token_hash = NULL, invited_at = NULL WHERE id = $1`, [signers[0].id]);
    expect((await resend({ envelope_id: envelopeId, signer_id: signers[0].id })).status).toBe(200);
    const [s] = await w.q<{ status: string; invited_at: string | null }>(`SELECT status, invited_at FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.status).toBe('invited');
    expect(s.invited_at).not.toBeNull();
  });

  it('refuses a finished signer, an envelope that is not live, and an unknown pair', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now() WHERE id = $1`, [signers[0].id]);
    const finished = await resend({ envelope_id: envelopeId, signer_id: signers[0].id });
    expect(finished.status).toBe(409);
    expect((await finished.json()).code).toBe('not_resendable');

    const other = await seedSentEnvelope(w, { signers: [{ email: 'grace@example.com' }] });
    const crossed = await resend({ envelope_id: envelopeId, signer_id: other.signers[0].id });
    expect(crossed.status).toBe(404);
    expect((await crossed.json()).code).toBe('signer_not_found');

    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
    const dead = await resend({ envelope_id: envelopeId, signer_id: signers[1].id });
    expect(dead.status).toBe(409);
    expect((await dead.json()).code).toBe('not_live');
  });

  it('answers 502 when the email did not go out, with the new link in place', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const res = await resend(
      { envelope_id: envelopeId, signer_id: signers[0].id },
      deps({ sendEmail: async () => ({ status: 'failed', channel: 'local', reason: 'rejected', httpStatus: 422 }) }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('email_failed');
    const [s] = await w.q<{ token_hash: string }>(`SELECT token_hash FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.token_hash).not.toBe(await sha256Hex(signers[0].token));
  });
});
