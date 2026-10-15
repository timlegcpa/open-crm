// @vitest-environment node
// esign-resend-webhook: Svix signatures over the raw bytes, the five-minute window, the
// two event types recorded once each, and a database failure answered 200.
import { beforeAll, describe, expect, it } from 'vitest';
import { base64ToBytes } from '../../../supabase/functions/_shared/crypto';
import {
  createResendWebhookHandler,
  normalizeTags,
  svixSign,
  svixSignatures,
  type ResendWebhookDeps,
} from '../../../supabase/functions/esign-resend-webhook/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, ORIGINS, seedSentEnvelope, type World } from './esign-world';

let w: World;
const KEY_B64 = Buffer.from('provider-secret-0123456789').toString('base64');
const SECRET = `whsec_${KEY_B64}`;
const NOW = new Date('2030-03-01T12:00:00Z');
const TS = String(NOW.getTime() / 1000);

function deps(over: Partial<ResendWebhookDeps> = {}): ResendWebhookDeps {
  return { allowedOrigins: ORIGINS, db: w.db, webhookSecret: SECRET, rateLimit: async () => 'allowed', now: () => NOW, logSink: w.logSink, ...over };
}

async function signed(payload: unknown, id = `msg_${Math.random().toString(36).slice(2)}`, ts = TS) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await svixSign(base64ToBytes(KEY_B64), id, ts, body);
  return { body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' } };
}

const deliver = async (req: { body: Uint8Array; headers: Record<string, string> }, d = deps()) =>
  createResendWebhookHandler(d)(edgeRequest({ origin: null, headers: req.headers, body: req.body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('svix helpers', () => {
  it('reads every v1 signature and the two tag shapes', () => {
    expect(svixSignatures('v1,abc v2,zzz v1,def  v1,')).toEqual(['abc', 'def']);
    expect(normalizeTags([{ name: 'esign_signer_id', value: 'x' }, { name: 1 }])).toEqual({ esign_signer_id: 'x' });
    expect(normalizeTags({ esign_signer_id: 'y', n: 2 })).toEqual({ esign_signer_id: 'y' });
    expect(normalizeTags(null)).toEqual({});
  });
});

// The Svix headers are this function's credential: a delivery notice for an unknown signer,
// signed, so a valid call reaches the database (and is ignored there).
const contract = await signed(
  { type: 'email.delivered', data: { tags: { esign_signer_id: '10000000-0000-4000-8000-0000000000e1' } } },
  'msg_contract',
);

describe('esign-resend-webhook', () => {
  describeEdgeContract({
    name: 'esign-resend-webhook',
    get handler() {
      return createResendWebhookHandler(deps());
    },
    get failingHandler() {
      return createResendWebhookHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createResendWebhookHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: { 'svix-id': contract.headers['svix-id'], 'svix-timestamp': contract.headers['svix-timestamp'], 'svix-signature': contract.headers['svix-signature'] },
    allowHeaders: ['svix-id', 'svix-timestamp', 'svix-signature'],
    body: { kind: 'bytes', valid: contract.body, maxBytes: 65_536 },
  });

  it('records a delivery and an open for a tagged invitation, each once', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const delivered = await signed({ type: 'email.delivered', data: { email_id: 'em_1', tags: { esign_signer_id: signers[0].id, kind: 'esign_invite' } } }, 'msg_delivered_1');
    expect(await (await deliver(delivered)).json()).toEqual({ ok: true });
    expect(await (await deliver(delivered)).json()).toEqual({ ok: true, deduped: true });
    const opened = await signed({ type: 'email.opened', data: { tags: [{ name: 'esign_signer_id', value: signers[0].id }] } });
    expect(await (await deliver(opened)).json()).toEqual({ ok: true });
    const events = await w.q<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM public.esign_envelope_events WHERE envelope_id = $1 ORDER BY event_type`,
      [envelopeId],
    );
    expect(events).toEqual([
      { event_type: 'email_delivered', metadata: { resend_email_id: 'em_1', kind: 'esign_invite' } },
      { event_type: 'email_opened', metadata: { resend_email_id: null, kind: 'esign_invite' } },
    ]);
  });

  it('accepts any of several signatures during a key rotation', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const req = await signed({ type: 'email.delivered', data: { tags: { esign_signer_id: signers[0].id } } });
    req.headers['svix-signature'] = `v1,${Buffer.from('not it').toString('base64')} ${req.headers['svix-signature']}`;
    expect((await deliver(req)).status).toBe(200);
  });

  it('refuses a wrong signature, a body changed after signing, and a stale or missing header', async () => {
    const good = await signed({ type: 'email.delivered', data: {} });
    const wrongKey = { ...good, headers: { ...good.headers, 'svix-signature': `v1,${await svixSign(base64ToBytes(Buffer.from('other-secret-0123456789').toString('base64')), good.headers['svix-id'], TS, good.body)}` } };
    expect((await deliver(wrongKey)).status).toBe(401);
    const changed = { ...good, body: new TextEncoder().encode('{"type":"email.opened","data":{}}') };
    const res = await deliver(changed);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('unauthenticated');
    const stale = await signed({ type: 'email.delivered', data: {} }, 'msg_stale', String(NOW.getTime() / 1000 - 301));
    expect((await deliver(stale)).status).toBe(401);
    const future = await signed({ type: 'email.delivered', data: {} }, 'msg_future', String(NOW.getTime() / 1000 + 301));
    expect((await deliver(future)).status).toBe(401);
    for (const header of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const missing = { ...good, headers: { ...good.headers } };
      delete (missing.headers as Record<string, string>)[header];
      expect((await deliver(missing)).status).toBe(401);
    }
  });

  it('ignores other event types and untagged messages, and is off without a secret', async () => {
    expect(await (await deliver(await signed({ type: 'email.bounced', data: {} }))).json()).toEqual({ ok: true, ignored: true });
    expect(await (await deliver(await signed({ type: 'email.delivered', data: { tags: { kind: 'other' } } }))).json()).toEqual({ ok: true, ignored: true });
    expect(await (await deliver(await signed({ type: 'email.delivered', data: { tags: { esign_signer_id: '10000000-0000-4000-8000-00000000dead' } } }))).json()).toEqual({ ok: true, ignored: true });
    const off = await deliver(await signed({ type: 'email.delivered', data: {} }), deps({ webhookSecret: null }));
    expect(off.status).toBe(503);
  });

  it('answers 200 when the database fails, so the provider does not retry forever', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const broken = {
      from: (t: string) => (t === 'esign_envelope_events' ? { insert: async () => ({ data: null, error: { message: 'down', code: '08006' } }) } : w.db.from(t)),
      rpc: w.db.rpc,
    };
    const res = await deliver(await signed({ type: 'email.delivered', data: { tags: { esign_signer_id: signers[0].id } } }), deps({ db: broken as never }));
    expect(await res.json()).toEqual({ ok: true, error: 'insert_failed' });
  });
});
