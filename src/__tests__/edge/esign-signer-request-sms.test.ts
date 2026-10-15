// @vitest-environment node
// esign-signer-request-sms: a uniform code whose HMAC is stored before the text leaves,
// the row removed when the text fails, the per-signer caps, and the setup refusals.
import { beforeAll, describe, expect, it } from 'vitest';
import { OutboundConfigError } from '../../../supabase/functions/_shared/outbound';
import { createSignerRequestSmsHandler, type SignerRequestSmsDeps } from '../../../supabase/functions/esign-signer-request-sms/handler';
import { randomSixDigits, smsCodeHash } from '../../../supabase/functions/esign-finalize-envelope/lib/sms';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, ORIGINS, PII_KEY, seedSentEnvelope, SIGNER_IP, SMS_CODE_KEY, type World } from './esign-world';

let w: World;

function deps(over: Partial<SignerRequestSmsDeps> = {}): SignerRequestSmsDeps {
  return {
    allowedOrigins: ORIGINS,
    db: w.db,
    loadOrg: w.loadOrg,
    sendSms: w.sendSms,
    piiKey: PII_KEY,
    smsCodeKey: SMS_CODE_KEY,
    rateLimit: async () => 'allowed',
    randomCode: () => '042917',
    logSink: w.logSink,
    ...over,
  };
}

const request = (token: string, d = deps()) =>
  createSignerRequestSmsHandler(d)(edgeRequest({ headers: { 'cf-connecting-ip': SIGNER_IP }, body: { token } }));

const highEnvelope = () => seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('randomSixDigits', () => {
  it('redraws values in the incomplete last block, so every code is equally likely', () => {
    const draws = [4_294_967_295, 4_294_000_000, 4_293_999_999];
    let i = 0;
    expect(randomSixDigits((b) => { b[0] = draws[i++]; return b; })).toBe('999999');
    expect(i).toBe(3);
    expect(randomSixDigits((b) => { b[0] = 7; return b; })).toBe('000007');
    expect(randomSixDigits()).toMatch(/^\d{6}$/);
  });

  it('hashes per signer, under the key', async () => {
    const a = await smsCodeHash(SMS_CODE_KEY, 'signer-a', '123456');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await smsCodeHash(SMS_CODE_KEY, 'signer-b', '123456')).not.toBe(a);
    expect(await smsCodeHash('cd'.repeat(32), 'signer-a', '123456')).not.toBe(a);
    await expect(smsCodeHash('short', 'signer-a', '123456')).rejects.toThrow();
  });
});

describe('esign-signer-request-sms', () => {
  describeEdgeContract({
    name: 'esign-signer-request-sms',
    get handler() {
      return createSignerRequestSmsHandler(deps());
    },
    get failingHandler() {
      return createSignerRequestSmsHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createSignerRequestSmsHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, maxBytes: 8_192 },
  });

  it('stores the HMAC of the code, then texts the decrypted number', async () => {
    const { envelopeId, signers } = await highEnvelope();
    const before = w.texts.length;
    // The row must exist by the time the text leaves: a code without one could never be checked.
    let rowsAtSend = -1;
    const watching = deps({
      sendSms: async (m) => {
        rowsAtSend = (await w.q(`SELECT 1 FROM public.esign_sms_verifications WHERE signer_id = $1`, [signers[0].id])).length;
        return w.sendSms(m);
      },
    });
    const res = await request(signers[0].token, watching);
    expect(rowsAtSend).toBe(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, last_four: '0123' });
    expect(w.texts.slice(before)).toEqual([{ to: '+15555550123', body: 'Acme: your signing code is 042917. It expires in 10 minutes.' }]);
    const [row] = await w.q<{ code_hash: string; sent_to_last_four: string; minutes: number }>(
      `SELECT code_hash, sent_to_last_four, round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes FROM public.esign_sms_verifications WHERE signer_id = $1`,
      [signers[0].id],
    );
    expect(row).toEqual({ code_hash: await smsCodeHash(SMS_CODE_KEY, signers[0].id, '042917'), sent_to_last_four: '0123', minutes: 10 });
    const [ev] = await w.q<{ metadata: unknown }>(`SELECT metadata FROM public.esign_envelope_events WHERE envelope_id = $1 AND event_type = 'sms_code_sent'`, [envelopeId]);
    expect(ev.metadata).toEqual({ last_four: '0123' });
  });

  it('removes the row when the text fails, and says so', async () => {
    const { signers } = await highEnvelope();
    const failed = await request(signers[0].token, deps({ sendSms: async () => ({ status: 'failed', channel: 'twilio', reason: 'rejected', httpStatus: 400 }) }));
    expect(failed.status).toBe(502);
    expect((await failed.json()).code).toBe('sms_failed');
    const unconfigured = await request(signers[0].token, deps({ sendSms: async () => { throw new OutboundConfigError('no provider'); } }));
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).code).toBe('sms_unavailable');
    expect(await w.q(`SELECT 1 FROM public.esign_sms_verifications WHERE signer_id = $1`, [signers[0].id])).toEqual([]);
  });

  it('caps a signer at 3 an hour and 10 in all', async () => {
    const { signers } = await highEnvelope();
    for (let i = 0; i < 3; i++) expect((await request(signers[0].token)).status).toBe(200);
    const hourly = await request(signers[0].token);
    expect(hourly.status).toBe(429);
    expect((await hourly.json()).code).toBe('too_many_codes');
    await w.q(`UPDATE public.esign_sms_verifications SET created_at = now() - interval '2 hours' WHERE signer_id = $1`, [signers[0].id]);
    await w.q(
      `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at)
       SELECT $1, repeat('0', 64), '0123', now(), now() - interval '2 hours' FROM generate_series(1, 7)`,
      [signers[0].id],
    );
    const lifetime = await request(signers[0].token);
    expect(lifetime.status).toBe(429);
    expect((await lifetime.json()).code).toBe('code_limit_reached');
    const hits = await w.q(`SELECT 1 FROM public.esign_envelope_events WHERE signer_id = $1 AND event_type = 'rate_limit_hit'`, [signers[0].id]);
    expect(hits).toHaveLength(2);
  });

  it("refuses a standard envelope's signer, and a server without its keys", async () => {
    const standard = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    expect((await request(standard.signers[0].token)).status).toBe(404);
    const { signers } = await highEnvelope();
    expect((await request(signers[0].token, deps({ smsCodeKey: null }))).status).toBe(503);
    expect((await request(signers[0].token, deps({ smsCodeKey: 'abc' }))).status).toBe(503);
    expect((await request(signers[0].token, deps({ piiKey: null }))).status).toBe(503);
  });

  it('refuses a signer with no phone on file', async () => {
    const { signers } = await seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com' }] });
    const res = await request(signers[0].token);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_phone');
  });
});
