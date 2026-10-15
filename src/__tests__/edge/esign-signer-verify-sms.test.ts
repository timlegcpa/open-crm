// @vitest-environment node
// esign-signer-verify-sms: the newest code only, counted guesses, a lock at five, and an
// address-pinned session on a match.
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createSignerVerifySmsHandler, type SignerVerifySmsDeps } from '../../../supabase/functions/esign-signer-verify-sms/handler';
import { smsCodeHash } from '../../../supabase/functions/esign-finalize-envelope/lib/sms';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, ORIGINS, seedSentEnvelope, SIGNER_IP, SMS_CODE_KEY, type World } from './esign-world';

let w: World;

function deps(over: Partial<SignerVerifySmsDeps> = {}): SignerVerifySmsDeps {
  return { allowedOrigins: ORIGINS, db: w.db, smsCodeKey: SMS_CODE_KEY, rateLimit: async () => 'allowed', logSink: w.logSink, ...over };
}

const verify = (body: Record<string, unknown>, d = deps(), headers: Record<string, string> = { 'cf-connecting-ip': SIGNER_IP }) =>
  createSignerVerifySmsHandler(d)(edgeRequest({ headers, body }));

async function codeFor(signerId: string, code: string, ageMinutes = 0) {
  await w.q(
    `INSERT INTO public.esign_sms_verifications (signer_id, code_hash, sent_to_last_four, expires_at, created_at)
     VALUES ($1, $2, '0123', now() + interval '10 minutes' - make_interval(mins => $3), now() - make_interval(mins => $3))`,
    [signerId, await smsCodeHash(SMS_CODE_KEY, signerId, code), ageMinutes],
  );
}

const highEnvelope = () => seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-signer-verify-sms', () => {
  describeEdgeContract({
    name: 'esign-signer-verify-sms',
    get handler() {
      return createSignerVerifySmsHandler(deps());
    },
    get failingHandler() {
      return createSignerVerifySmsHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createSignerVerifySmsHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', code: '123456' }, maxBytes: 8_192 },
  });

  it('opens a session pinned to the caller on the right code, once', async () => {
    const { signers } = await highEnvelope();
    await codeFor(signers[0].id, '123456');
    const res = await verify({ token: signers[0].token, code: '123456' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const [session] = await w.q<{ hash: string; ip: string; minutes: number }>(
      `SELECT session_token_hash AS hash, host(ip) AS ip, round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes FROM public.esign_signer_sessions WHERE signer_id = $1`,
      [signers[0].id],
    );
    expect(session).toEqual({ hash: await sha256Hex(body.session_token), ip: SIGNER_IP, minutes: 30 });
    expect(await (await verify({ token: signers[0].token, code: '123456' })).json()).toEqual({ ok: false, state: 'none', attempts_left: 0 });
  });

  it('counts wrong guesses and locks the code at five', async () => {
    const { signers } = await highEnvelope();
    await codeFor(signers[0].id, '123456');
    for (let left = 4; left >= 1; left--) {
      expect(await (await verify({ token: signers[0].token, code: '000000' })).json()).toEqual({ ok: false, state: 'invalid', attempts_left: left });
    }
    expect(await (await verify({ token: signers[0].token, code: '000000' })).json()).toEqual({ ok: false, state: 'locked', attempts_left: 0 });
    expect(await (await verify({ token: signers[0].token, code: '123456' })).json()).toEqual({ ok: false, state: 'locked', attempts_left: 0 });
    const failed = await w.q<{ metadata: { attempts: number } }>(`SELECT metadata FROM public.esign_envelope_events WHERE signer_id = $1 AND event_type = 'sms_code_failed' ORDER BY created_at`, [signers[0].id]);
    expect(failed.map((e) => e.metadata.attempts)).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('checks only the newest code, and refuses an expired one', async () => {
    const { signers } = await highEnvelope();
    await codeFor(signers[0].id, '111111', 2);
    await codeFor(signers[0].id, '222222');
    expect((await (await verify({ token: signers[0].token, code: '111111' })).json()).state).toBe('invalid');
    const other = await highEnvelope();
    await codeFor(other.signers[0].id, '333333', 11);
    expect(await (await verify({ token: other.signers[0].token, code: '333333' })).json()).toEqual({ ok: false, state: 'expired', attempts_left: 0 });
  });

  it('refuses a malformed code, a call with no address, and a standard envelope', async () => {
    const { signers } = await highEnvelope();
    const bad = await verify({ token: signers[0].token, code: '12345' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_code');
    const noIp = await verify({ token: signers[0].token, code: '123456' }, deps(), {});
    expect(noIp.status).toBe(400);
    expect((await noIp.json()).code).toBe('no_address');
    const standard = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    expect((await verify({ token: standard.signers[0].token, code: '123456' })).status).toBe(404);
  });
});
