// @vitest-environment node
// esign-create-envelope against the real migrations: a draft with a cleaned title, an
// existing primary contact, and 'high' only when a code can actually be texted.
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreateEnvelopeHandler, type CreateEnvelopeDeps } from '../../../supabase/functions/esign-create-envelope/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, OWNER_ID, throwInternal } from './contract';
import { createWorld, ORIGINS, seedContact, type World } from './esign-world';

let w: World;

function deps(over: Partial<CreateEnvelopeDeps> = {}): CreateEnvelopeDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    smsEnv: { production: false, twilioConfigured: false },
    logSink: w.logSink,
    ...over,
  };
}

const create = (body: unknown, d = deps()) => createCreateEnvelopeHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-create-envelope', () => {
  describeEdgeContract({
    name: 'esign-create-envelope',
    get handler() {
      return createCreateEnvelopeHandler(deps());
    },
    get failingHandler() {
      return createCreateEnvelopeHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { title: 'Engagement letter' }, maxBytes: 16_384 },
  });

  it('creates a draft with a cleaned title and records envelope_created', async () => {
    const res = await create({ title: '  Engagement\u0007 letter  ', verification_level: 'nonsense' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ title: 'Engagement letter', verification_level: 'standard', status: 'draft' });
    expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'status', 'title', 'verification_level']);
    const [row] = await w.q<{ created_by: string }>(`SELECT created_by FROM public.esign_envelopes WHERE id = $1`, [body.id]);
    expect(row.created_by).toBe(OWNER_ID);
    const events = await w.q<{ event_type: string; metadata: unknown }>(`SELECT event_type, metadata FROM public.esign_envelope_events WHERE envelope_id = $1`, [body.id]);
    expect(events).toEqual([{ event_type: 'envelope_created', metadata: { title: 'Engagement letter', verification_level: 'standard' } }]);
  });

  it('refuses an empty or overlong title', async () => {
    for (const title of ['', '   ', '\u0001', 'x'.repeat(201), 42]) {
      const res = await create({ title });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_title');
    }
  });

  it('links an existing primary contact and refuses one that does not exist', async () => {
    const contactId = await seedContact(w, { email: 'grace@example.com', first_name: 'Grace' });
    const ok = await create({ title: 'Letter', primary_contact_id: contactId });
    expect(ok.status).toBe(200);
    const [row] = await w.q<{ primary_contact_id: string }>(`SELECT primary_contact_id FROM public.esign_envelopes WHERE id = $1`, [(await ok.json()).id]);
    expect(row.primary_contact_id).toBe(contactId);

    const missing = await create({ title: 'Letter', primary_contact_id: '10000000-0000-4000-8000-00000000dead' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('contact_not_found');
    expect((await create({ title: 'Letter', primary_contact_id: 'not-a-uuid' })).status).toBe(400);
  });

  it("allows 'high' only when a code can be texted", async () => {
    // Outside production the code goes to dev_outbox, so it is available.
    expect((await create({ title: 'High', verification_level: 'high' })).status).toBe(200);
    // Production with no Twilio: refused.
    const refused = await create({ title: 'High', verification_level: 'high' }, deps({ smsEnv: { production: true, twilioConfigured: false } }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('sms_unavailable');
    // Production with Twilio: allowed, unless the owner turned SMS off.
    expect((await create({ title: 'High', verification_level: 'high' }, deps({ smsEnv: { production: true, twilioConfigured: true } }))).status).toBe(200);
    await w.q(`INSERT INTO public.app_settings (key, value) VALUES ('esign', '{"sms_enabled": false}')`);
    try {
      const off = await create({ title: 'High', verification_level: 'high' }, deps({ smsEnv: { production: true, twilioConfigured: true } }));
      expect(off.status).toBe(409);
      expect((await create({ title: 'Standard' })).status).toBe(200);
    } finally {
      await w.q(`DELETE FROM public.app_settings WHERE key = 'esign'`);
    }
  });
});
