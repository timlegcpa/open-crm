// @vitest-environment node
// esign-send-envelope against the real migrations: every problem at once, the assembled
// source and its digest, the guarded claim, per-signer links, portal tasks and invitations.
import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createSendEnvelopeHandler, type SendEnvelopeDeps } from '../../../supabase/functions/esign-send-envelope/handler';
import { sha256Bytes } from '../../../supabase/functions/esign-finalize-envelope/lib/pdf';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { addField, createWorld, ORIGINS, pdfTools, seedContact, seedDraft, SITE_URL, withRace, type World } from './esign-world';

let w: World;

function deps(over: Partial<SendEnvelopeDeps> = {}): SendEnvelopeDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    storage: w.storage,
    pdf: pdfTools(),
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    siteUrl: SITE_URL,
    smsEnv: { production: false, twilioConfigured: false },
    logSink: w.logSink,
    ...over,
  };
}

const send = (envelopeId: string, d = deps()) =>
  createSendEnvelopeHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body: { envelope_id: envelopeId } }));

async function readyDraft(opts: Parameters<typeof seedDraft>[1] = {}) {
  const draft = await seedDraft(w, { signers: [{ email: 'ada@example.com' }], ...opts });
  for (const s of draft.signerIds) await addField(w, draft.envelopeId, s);
  return draft;
}

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-send-envelope', () => {
  describeEdgeContract({
    name: 'esign-send-envelope',
    get handler() {
      return createSendEnvelopeHandler(deps());
    },
    get failingHandler() {
      return createSendEnvelopeHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 16_384 },
  });

  it('assembles the source, records its digest, claims the send and invites each signer', async () => {
    const contactId = await seedContact(w, { email: 'grace@example.com', first_name: 'Grace', last_name: 'Hopper' });
    const draft = await readyDraft({ signers: [{ email: 'grace@example.com', contactId, role: 'primary' }, { email: 'alan@example.com' }], pages: 3 });
    const before = w.emails.length;
    const res = await send(draft.envelopeId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope_id: draft.envelopeId, signers_invited: 2, failed_emails: [] });

    const [env] = await w.q<{ status: string; source_pdf_path: string; source_pdf_sha256: string; expires_at: string; sent_at: string }>(
      `SELECT status, source_pdf_path, source_pdf_sha256, expires_at::text, sent_at::text FROM public.esign_envelopes WHERE id = $1`,
      [draft.envelopeId],
    );
    expect(env.status).toBe('sent');
    expect(env.source_pdf_path).toBe(`${draft.envelopeId}/source.pdf`);
    const assembled = w.storage.working.get(env.source_pdf_path) as Uint8Array;
    expect(env.source_pdf_sha256).toBe(await sha256Bytes(assembled));
    expect((await pdfLib.PDFDocument.load(assembled)).getPageCount()).toBe(3);
    expect(Date.parse(env.expires_at) - Date.parse(env.sent_at)).toBe(14 * 24 * 3600 * 1000);

    const signers = await w.q<{ email: string; status: string; token_hash: string; invited_at: string | null }>(
      `SELECT email, status, token_hash, invited_at FROM public.esign_envelope_signers WHERE envelope_id = $1 ORDER BY "order"`,
      [draft.envelopeId],
    );
    expect(signers.map((s) => s.status)).toEqual(['invited', 'invited']);

    const invites = w.emails.slice(before);
    expect(invites.map((m) => m.to)).toEqual(['grace@example.com', 'alan@example.com']);
    // The link carries the token in the fragment, and only its hash is stored.
    for (const [i, m] of invites.entries()) {
      const token = /\/sign#token=([A-Za-z0-9_-]+)/.exec(m.html)?.[1] as string;
      expect(m.text).toContain(`${SITE_URL}/sign#token=${token}`);
      expect(await sha256Hex(token)).toBe(signers[i].token_hash);
      expect(m.tags).toMatchObject({ kind: 'esign_invite' });
      expect(m.idempotencyKey).toMatch(/^esign-invite:[0-9a-f-]{36}:[0-9a-f]{16}$/);
    }
    expect(invites[0].html).toContain('Grace Hopper');

    const events = await w.q<{ event_type: string }>(`SELECT event_type FROM public.esign_envelope_events WHERE envelope_id = $1 ORDER BY event_type`, [draft.envelopeId]);
    expect(events.map((e) => e.event_type)).toEqual(['envelope_sent', 'invite_sent', 'invite_sent']);
  });

  it('lists every problem at once and changes nothing', async () => {
    const draft = await seedDraft(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }], level: 'high' });
    await addField(w, draft.envelopeId, draft.signerIds[0], 5);
    const res = await send(draft.envelopeId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation_failed');
    expect(body.error).toBe('This envelope has 4 problems to fix before it can be sent.');
    expect(body.validation).toEqual([
      'Signer alan@example.com has no required fields.',
      'A field is on page 6, which this envelope does not have.',
      'Signer ada@example.com needs a phone number for text message verification.',
      'Signer alan@example.com needs a phone number for text message verification.',
    ]);
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [draft.envelopeId]);
    expect(env.status).toBe('draft');
    expect(w.storage.working.has(`${draft.envelopeId}/source.pdf`)).toBe(false);
  });

  it('refuses a draft with no pages or no signers, with one problem as the sentence', async () => {
    const draft = await seedDraft(w, { signers: [] });
    await w.q(`UPDATE public.esign_envelope_pages SET deleted = true WHERE envelope_id = $1`, [draft.envelopeId]);
    const body = await (await send(draft.envelopeId)).json();
    expect(body.validation).toEqual(['At least one page is required.', 'At least one signer is required.']);
    const one = await seedDraft(w, { signers: [] });
    const single = await (await send(one.envelopeId)).json();
    expect(single.error).toBe('At least one signer is required.');
  });

  it('refuses a send that is not a draft, and a second send of the same draft', async () => {
    const draft = await readyDraft();
    expect((await send(draft.envelopeId)).status).toBe(200);
    const again = await send(draft.envelopeId);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('not_draft');
    expect((await send('10000000-0000-4000-8000-00000000dead')).status).toBe(404);
  });

  it('loses the claim cleanly when another send won meanwhile', async () => {
    const draft = await readyDraft();
    // The claim's guard is status = draft: another request voids it between read and write.
    const racing = withRace(w, 'esign_envelopes', (v) => v.status === 'sent', `UPDATE public.esign_envelopes SET status = 'voided', expires_at = now() WHERE id = $1`, [draft.envelopeId]);
    const res = await send(draft.envelopeId, deps({ db: racing }));
    expect(res.status).toBe(409);
    const [s] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE envelope_id = $1`, [draft.envelopeId]);
    expect(s.status).toBe('pending');
  });

  it("refuses 'high' when no code can be texted", async () => {
    const draft = await readyDraft({ level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    const res = await send(draft.envelopeId, deps({ smsEnv: { production: true, twilioConfigured: false } }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('sms_unavailable');
    await w.q(`INSERT INTO public.app_settings (key, value) VALUES ('esign', '{"sms_enabled": false}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    expect((await send(draft.envelopeId)).status).toBe(409);
    await w.q(`DELETE FROM public.app_settings WHERE key = 'esign'`);
    expect((await send(draft.envelopeId)).status).toBe(200);
  });

  it('refuses without SITE_URL, before anything changes', async () => {
    const draft = await readyDraft();
    const res = await send(draft.envelopeId, deps({ siteUrl: null }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('site_url_missing');
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [draft.envelopeId]);
    expect(env.status).toBe('draft');
  });

  it('refuses an assembled document over 24 MB', async () => {
    const draft = await readyDraft();
    const big = deps({ pdf: { assemblePdf: async () => new Uint8Array(24 * 1024 * 1024 + 1) } });
    const res = await send(draft.envelopeId, big);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('too_large');
  });

  it('creates a portal task for a signer with an active portal account, linked by signer id', async () => {
    const contactId = await seedContact(w, { email: 'kat@example.com', first_name: 'Katherine' });
    await w.q(`INSERT INTO public.client_portal_accounts (contact_id, status) VALUES ($1, 'active')`, [contactId]);
    const draft = await readyDraft({ title: 'Lease', signers: [{ email: 'kat@example.com', contactId }, { email: 'alan@example.com' }] });
    expect((await send(draft.envelopeId)).status).toBe(200);
    const tasks = await w.q<{ id: string; title: string; link: string; type: string; status: string }>(
      `SELECT id, title, link, type, status FROM public.client_tasks WHERE contact_id = $1`,
      [contactId],
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Sign: Lease', link: `/portal/sign?signer=${draft.signerIds[0]}`, type: 'esign', status: 'pending' });
    const [s] = await w.q<{ client_task_id: string }>(`SELECT client_task_id FROM public.esign_envelope_signers WHERE id = $1`, [draft.signerIds[0]]);
    expect(s.client_task_id).toBe(tasks[0].id);
  });

  it('lists a signer whose invitation failed, and keeps the rest', async () => {
    const draft = await readyDraft({ signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    const failing = deps({
      sendEmail: async (m) => (m.to === 'ada@example.com' ? { status: 'failed', channel: 'local', reason: 'rejected', httpStatus: 422 } : w.sendEmail(m)),
    });
    const res = await send(draft.envelopeId, failing);
    expect(await res.json()).toMatchObject({ signers_invited: 1, failed_emails: ['ada@example.com'] });
  });
});
