// @vitest-environment node
// esign-finalize-envelope against the real migrations and the real pdf-lib, plus the PDF
// library contract every PDF function shares (fonts, versions, the merge plan) and the
// whole flow end to end: create, upload, signers, fields, send, resolve, view, sign, the
// executed copy, and the tamper check that verifies it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import * as pdfLib from 'pdf-lib';
import { sha256Hex } from '../../../supabase/functions/_shared/crypto';
import { createFinalizeEnvelopeHandler, executedFileTitle, type FinalizeEnvelopeDeps } from '../../../supabase/functions/esign-finalize-envelope/handler';
import { planMerge, sha256Bytes, type SignerStamp } from '../../../supabase/functions/esign-finalize-envelope/lib/pdf';
import { SIGNATURE_FONT_FILES, TYPED_SIGNATURE_PATTERN } from '../../../supabase/functions/esign-finalize-envelope/lib/typed-signature';
import { createCreateEnvelopeHandler } from '../../../supabase/functions/esign-create-envelope/handler';
import { createUploadDocumentHandler } from '../../../supabase/functions/esign-upload-document/handler';
import { createManageSignersHandler } from '../../../supabase/functions/esign-manage-signers/handler';
import { createManageFieldsHandler } from '../../../supabase/functions/esign-manage-fields/handler';
import { createSendEnvelopeHandler } from '../../../supabase/functions/esign-send-envelope/handler';
import { createResolveTokenHandler } from '../../../supabase/functions/esign-resolve-token/handler';
import { createSignerViewPdfHandler } from '../../../supabase/functions/esign-signer-view-pdf/handler';
import { createSignerSignHandler } from '../../../supabase/functions/esign-signer-sign/handler';
import { createVerifyDocumentHandler } from '../../../supabase/functions/esign-verify-document/handler';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, INTERNAL_SECRET, throwInternal } from './contract';
import {
  createWorld,
  drawnSignaturePng,
  FONT_DIR,
  makePdf,
  ORIGINS,
  OWNER_EMAIL,
  PII_KEY,
  pdfTools,
  seedContact,
  seedSentEnvelope,
  SIGNER_IP,
  SITE_URL,
  withRace,
  type World,
} from './esign-world';

let w: World;
const INTERNAL = { 'x-internal-token': INTERNAL_SECRET };

function deps(over: Partial<FinalizeEnvelopeDeps> = {}): FinalizeEnvelopeDeps {
  return {
    allowedOrigins: ORIGINS,
    internalToken: INTERNAL_SECRET,
    db: w.db,
    storage: w.storage,
    pdf: pdfTools(true),
    loadOrg: w.loadOrg,
    sendEmail: w.sendEmail,
    ownerEmail: async () => OWNER_EMAIL,
    siteUrl: SITE_URL,
    logSink: w.logSink,
    ...over,
  };
}

const finalize = (envelopeId: string, d = deps()) =>
  createFinalizeEnvelopeHandler(d)(edgeRequest({ origin: null, headers: INTERNAL, body: { envelope_id: envelopeId } }));

/** A sent envelope whose signers have all signed (typed, or drawn for the second). */
async function allSigned(opts: { drawnSecond?: boolean; title?: string } = {}) {
  const ada = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', spouse_email: 'byron@example.com', spouse_first_name: 'Byron', spouse_last_name: 'Lord' });
  const seeded = await seedSentEnvelope(w, {
    title: opts.title ?? 'Lease',
    primaryContactId: ada,
    signers: [{ email: 'ada@example.com', contactId: ada, role: 'primary' }, { email: 'byron@example.com', contactId: ada, role: 'co_signer' }],
  });
  await w.q(
    `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_kind = 'typed', signed_signature_text = 'Ada Lovelace', signed_font = 'great_vibes', signed_timezone = 'UTC', signed_verification_method = 'email' WHERE id = $1`,
    [seeded.signers[0].id],
  );
  if (opts.drawnSecond) {
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_kind = 'drawn', signed_verification_method = 'email' WHERE id = $1`, [seeded.signers[1].id]);
    await w.q(`INSERT INTO public.esign_signer_signature_images (signer_id, image_base64) VALUES ($1, $2)`, [seeded.signers[1].id, await drawnSignaturePng()]);
  } else {
    await w.q(
      `UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_kind = 'typed', signed_signature_text = 'Byron Lord', signed_font = 'pacifico', signed_verification_method = 'email' WHERE id = $1`,
      [seeded.signers[1].id],
    );
  }
  // A date field too, placed while the envelope was a draft (the database takes shape changes from drafts only).
  await w.q(`UPDATE public.esign_envelopes SET status = 'draft' WHERE id = $1`, [seeded.envelopeId]);
  await w.q(`INSERT INTO public.esign_envelope_fields (envelope_id, signer_id, page_index, field_type, x, y, width, height) VALUES ($1, $2, 1, 'date', 300, 100, 100, 20)`, [seeded.envelopeId, seeded.signers[0].id]);
  await w.q(`UPDATE public.esign_envelopes SET status = 'sent' WHERE id = $1`, [seeded.envelopeId]);
  return { ...seeded, contactId: ada };
}

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('the PDF library contract', () => {
  const PDF_FUNCTIONS = ['esign-upload-document', 'esign-send-envelope', 'esign-signer-sign', 'esign-finalize-envelope', 'esign-download-audit'];

  it('maps one pdf-lib and one fontkit, pinned, in every PDF function and in package.json', () => {
    for (const fn of PDF_FUNCTIONS) {
      const imports = JSON.parse(readFileSync(`supabase/functions/${fn}/deno.json`, 'utf8')).imports;
      expect([fn, imports['pdf-lib'], imports['@pdf-lib/fontkit']]).toEqual([fn, 'npm:pdf-lib@1.17.1', 'npm:@pdf-lib/fontkit@1.1.1']);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['pdf-lib']).toBe('^1.17.1');
    expect(pkg.dependencies['@pdf-lib/fontkit']).toBe('^1.1.1');
    expect(JSON.parse(readFileSync('node_modules/pdf-lib/package.json', 'utf8')).version).toBe('1.17.1');
    expect(JSON.parse(readFileSync('node_modules/@pdf-lib/fontkit/package.json', 'utf8')).version).toBe('1.1.1');
  });

  it('every signature font draws every character a typed signature may hold', () => {
    // Every code point the rule accepts, enumerated (the letter set is written with ranges).
    const chars: string[] = [];
    for (let cp = 0x20; cp <= 0x2ff; cp++) if (TYPED_SIGNATURE_PATTERN.test(String.fromCodePoint(cp))) chars.push(String.fromCodePoint(cp));
    expect(chars.length).toBeGreaterThan(52 + 60);
    expect(chars).toEqual(expect.arrayContaining(['A', 'z', 'é', 'ÿ', 'Ł', 'ž', ' ', "'", '-']));
    expect(chars).not.toContain('×');
    for (const file of Object.values(SIGNATURE_FONT_FILES)) {
      const font = (fontkit as unknown as { create(b: Uint8Array): { hasGlyphForCodePoint(cp: number): boolean } }).create(new Uint8Array(readFileSync(join(FONT_DIR, file))));
      const missing = chars.filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0) as number));
      expect([file, missing]).toEqual([file, []]);
    }
  });

  it('plans the live pages in order, numbered from zero', () => {
    expect(
      planMerge([
        { order: 2, source_document_id: 'b', source_page_index: 0, deleted: false },
        { order: 0, source_document_id: 'a', source_page_index: 1, deleted: false },
        { order: 1, source_document_id: 'a', source_page_index: 0, deleted: true },
      ]),
    ).toEqual([
      { source_document_id: 'a', source_page_index: 1, final_index: 0 },
      { source_document_id: 'b', source_page_index: 0, final_index: 1 },
    ]);
  });

  it('names the executed copy from the title, without what the documents store refuses', () => {
    expect(executedFileTitle('Lease: 2030/31')).toBe('Lease_ 2030_31');
    expect(executedFileTitle('Lease ‮ fdp')).toBe('Lease  fdp');
    expect(executedFileTitle('​')).toBe('Signed document');
  });
});

describe('esign-finalize-envelope', () => {
  describeEdgeContract({
    name: 'esign-finalize-envelope',
    get handler() {
      return createFinalizeEnvelopeHandler(deps());
    },
    get failingHandler() {
      return createFinalizeEnvelopeHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: INTERNAL,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 16_384 },
  });

  it('stamps, stores once, claims completion with the digest of the stored file, and files a copy per contact', async () => {
    const { envelopeId, contactId, signers } = await allSigned({ drawnSecond: true });
    const before = w.emails.length;
    const res = await finalize(envelopeId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const path = `${contactId}/esign/${envelopeId}.pdf`;
    const stored = w.storage.documents.get(path) as Uint8Array;
    expect(body).toEqual({ ok: true, signed_pdf_path: path, sha256: await sha256Bytes(stored) });

    const [env] = await w.q<{ status: string; signed_pdf_path: string; signed_pdf_sha256: string; completed_at: string | null }>(
      `SELECT status, signed_pdf_path, signed_pdf_sha256, completed_at::text FROM public.esign_envelopes WHERE id = $1`,
      [envelopeId],
    );
    expect(env).toMatchObject({ status: 'completed', signed_pdf_path: path, signed_pdf_sha256: body.sha256 });
    const doc = await pdfLib.PDFDocument.load(stored);
    expect(doc.getPageCount()).toBeGreaterThan(2);

    // Two signers on one contact: one documents row, in the default folder, held by the owner.
    const docs = await w.q<Record<string, unknown>>(
      `SELECT contact_id, filename, original_filename, storage_path, mime_type, folder_path, held_by, encryption_status, esign_envelope_id, file_size FROM public.client_documents WHERE esign_envelope_id = $1`,
      [envelopeId],
    );
    expect(docs).toEqual([
      {
        contact_id: contactId,
        filename: `${envelopeId}.pdf`,
        original_filename: 'Lease.pdf',
        storage_path: path,
        mime_type: 'application/pdf',
        folder_path: '/Signed documents/',
        held_by: 'owner',
        encryption_status: 'none',
        esign_envelope_id: envelopeId,
        file_size: stored.byteLength,
      },
    ]);
    const mails = w.emails.slice(before);
    expect(mails.map((m) => m.to)).toEqual(['ada@example.com', 'byron@example.com', OWNER_EMAIL]);
    expect(mails[0].attachments?.[0].filename).toBe('Lease_signed.pdf');
    expect(mails[0].attachments?.[0].content).toEqual(stored);
    expect(mails[1].html).toContain('Byron Lord');
    expect(mails[0].idempotencyKey).toBe(`esign_completed:${envelopeId}:${await sha256Hex('ada@example.com')}`);
    const done = await w.q(`SELECT 1 FROM public.esign_envelope_events WHERE envelope_id = $1 AND event_type = 'envelope_completed'`, [envelopeId]);
    expect(done).toHaveLength(1);
  });

  it('files under the folder chain the settings name, one row per contact', async () => {
    await w.q(`INSERT INTO public.app_settings (key, value) VALUES ('esign', '{"filing_folder": "Contracts/Signed"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    try {
      const ada = await seedContact(w, { email: 'ada@example.com' });
      const alan = await seedContact(w, { email: 'alan@example.com' });
      const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com', contactId: ada }, { email: 'alan@example.com', contactId: alan }, { email: 'grace@example.com' }] });
      await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_text = 'Ada', signed_font = 'allison' WHERE envelope_id = $1`, [envelopeId]);
      expect((await finalize(envelopeId)).status).toBe(200);
      const docs = await w.q<{ contact_id: string; folder_path: string }>(`SELECT contact_id, folder_path FROM public.client_documents WHERE esign_envelope_id = $1 ORDER BY contact_id`, [envelopeId]);
      expect(docs.map((d) => d.folder_path)).toEqual(['/Contracts/Signed/', '/Contracts/Signed/']);
      expect(new Set(docs.map((d) => d.contact_id))).toEqual(new Set([ada, alan]));
      const folders = await w.q<{ parent_path: string; name: string }>(`SELECT parent_path, name FROM public.client_folders WHERE contact_id = $1 ORDER BY parent_path`, [alan]);
      expect(folders).toEqual([{ parent_path: '/', name: 'Contracts' }, { parent_path: '/Contracts/', name: 'Signed' }]);
    } finally {
      await w.q(`DELETE FROM public.app_settings WHERE key = 'esign'`);
    }
  });

  it('refuses until every signer has signed with something it can draw, changing nothing', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com', contactId: await seedContact(w) }] });
    const notYet = await finalize(envelopeId);
    expect(notYet.status).toBe(409);
    expect((await notYet.json()).code).toBe('not_all_signed');
    // A signature on file is not a signing: the status decides.
    await w.q(`UPDATE public.esign_envelope_signers SET signed_signature_text = 'Ada', signed_font = 'allison' WHERE id = $1`, [signers[0].id]);
    expect((await finalize(envelopeId)).status).toBe(409);
    await w.q(`UPDATE public.esign_envelope_signers SET signed_signature_text = NULL, signed_font = NULL WHERE id = $1`, [signers[0].id]);
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_kind = 'drawn' WHERE id = $1`, [signers[0].id]);
    expect((await finalize(envelopeId)).status).toBe(409);
    await w.q(`UPDATE public.esign_envelope_signers SET signed_signature_kind = 'typed', signed_signature_text = 'Ada', signed_font = 'comic_sans' WHERE id = $1`, [signers[0].id]);
    expect((await finalize(envelopeId)).status).toBe(409);
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('sent');
  });

  it('when the path is already taken, records the digest of the stored file', async () => {
    const { envelopeId, contactId } = await allSigned();
    const path = `${contactId}/esign/${envelopeId}.pdf`;
    const winner = await makePdf(3);
    w.storage.documents.set(path, winner);
    const body = await (await finalize(envelopeId)).json();
    expect(body.sha256).toBe(await sha256Bytes(winner));
    const [env] = await w.q<{ s: string }>(`SELECT signed_pdf_sha256 AS s FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.s).toBe(await sha256Bytes(winner));
  });

  it('answers already completed when another call won the claim, delivering nothing twice', async () => {
    const { envelopeId } = await allSigned();
    const racing = withRace(w, 'esign_envelopes', (v) => v.status === 'completed', `UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
    const before = w.emails.length;
    const res = await finalize(envelopeId, deps({ db: racing }));
    expect((await res.json()).already_completed).toBe(true);
    expect(w.emails.length).toBe(before);
    expect(await w.q(`SELECT 1 FROM public.client_documents WHERE esign_envelope_id = $1`, [envelopeId])).toEqual([]);
  });

  it('re-drives the deliverables of a completed envelope a crash cut short, skipping what is done', async () => {
    const { envelopeId } = await allSigned();
    expect((await finalize(envelopeId)).status).toBe(200);
    const [first] = await w.q<{ delivered_at: string | null; n: number }>(
      `SELECT delivered_at::text, (SELECT count(*)::int FROM jsonb_object_keys(delivery->'emails')) AS n FROM public.esign_envelopes WHERE id = $1`,
      [envelopeId],
    );
    expect(first.delivered_at).not.toBeNull();
    expect(first.n).toBe(3);
    // A crash after the emails went out, before the filing landed.
    await w.q(`DELETE FROM public.client_documents WHERE esign_envelope_id = $1`, [envelopeId]);
    await w.q(`UPDATE public.esign_envelopes SET delivered_at = NULL WHERE id = $1`, [envelopeId]);
    const before = w.emails.length;
    const recovered = await (await finalize(envelopeId)).json();
    expect(recovered).toMatchObject({ recovered: true, delivered: true });
    expect(await w.q(`SELECT 1 FROM public.client_documents WHERE esign_envelope_id = $1`, [envelopeId])).toHaveLength(1);
    expect(w.emails.length).toBe(before);
    expect((await (await finalize(envelopeId)).json()).already_completed).toBe(true);
    expect(w.emails.length).toBe(before);
    expect(await w.q(`SELECT 1 FROM public.esign_envelope_events WHERE envelope_id = $1 AND event_type = 'envelope_completed'`, [envelopeId])).toHaveLength(1);
  });

  it('a failed completion email is retried later for that party alone, and the envelope stays undelivered until it goes', async () => {
    const { envelopeId } = await allSigned();
    let refuse = 'byron@example.com';
    const sendEmail: FinalizeEnvelopeDeps['sendEmail'] = async (m) => {
      if (m.to === refuse) return { status: 'failed', channel: 'local', reason: 'rejected', httpStatus: 422 };
      return w.sendEmail(m);
    };
    const res = await (await finalize(envelopeId, deps({ sendEmail }))).json();
    expect(res.sha256).toBeDefined();
    const [env] = await w.q<{ delivered_at: string | null; delivery_attempts: number }>(
      `SELECT delivered_at::text, delivery_attempts FROM public.esign_envelopes WHERE id = $1`,
      [envelopeId],
    );
    expect(env).toEqual({ delivered_at: null, delivery_attempts: 1 });
    refuse = '';
    const before = w.emails.length;
    expect(await (await finalize(envelopeId, deps({ sendEmail }))).json()).toMatchObject({ recovered: true, delivered: true });
    expect(w.emails.slice(before).map((m) => m.to)).toEqual(['byron@example.com']);
  });

  it('two delivery runs at once file one copy per contact', async () => {
    const { envelopeId } = await allSigned();
    expect((await finalize(envelopeId)).status).toBe(200);
    await w.q(`DELETE FROM public.client_documents WHERE esign_envelope_id = $1`, [envelopeId]);
    await w.q(`UPDATE public.esign_envelopes SET delivered_at = NULL WHERE id = $1`, [envelopeId]);
    const answers = await Promise.all([finalize(envelopeId), finalize(envelopeId)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(await w.q(`SELECT 1 FROM public.client_documents WHERE esign_envelope_id = $1`, [envelopeId])).toHaveLength(1);
  });

  it('refuses an envelope no contact can hold, and one that is not live', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_text = 'Alan', signed_font = 'allison' WHERE envelope_id = $1`, [envelopeId]);
    const orphan = await finalize(envelopeId);
    expect(orphan.status).toBe(409);
    expect((await orphan.json()).code).toBe('no_owner_contact');
    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
    expect((await (await finalize(envelopeId)).json()).code).toBe('not_finalizable');
  });
});

describe('the whole flow', () => {
  it('creates, sends, signs and completes an envelope whose executed copy verifies', async () => {
    const owner = CREDENTIALS.owner;
    const base = { allowedOrigins: ORIGINS, db: w.db, logSink: w.logSink };
    const ownerDeps = { ...base, authorizeOwner: fakeOwnerAuth() };
    const pdf = pdfTools(true);
    const call = async (h: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = owner) => {
      const res = await h(edgeRequest({ headers, body }));
      expect(res.status).toBeLessThan(300);
      return res;
    };
    const contactId = await seedContact(w, { email: 'flow@example.com', first_name: 'Ada', last_name: 'Lovelace' });

    const created = await (await call(createCreateEnvelopeHandler({ ...ownerDeps, smsEnv: { production: false, twilioConfigured: false } }), { title: 'Flow lease', primary_contact_id: contactId })).json();
    const form = new FormData();
    form.append('file', new Blob([(await makePdf(2)) as BlobPart], { type: 'application/pdf' }), 'flow.pdf');
    form.append('envelope_id', created.id);
    form.append('file_name', 'Flow.pdf');
    await call(createUploadDocumentHandler({ ...ownerDeps, storage: w.storage, pdf }), form);
    const signer = await (
      await call(createManageSignersHandler({ ...ownerDeps, piiKey: PII_KEY }), {
        envelope_id: created.id,
        action: 'add',
        signer: { email: 'flow@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'primary', contact_id: contactId, order: 0 },
      })
    ).json();
    await call(createManageFieldsHandler(ownerDeps), {
      envelope_id: created.id,
      action: 'set',
      signer_id: signer.signer_id,
      fields: [{ page_index: 0, field_type: 'signature', x: 50, y: 100, width: 200, height: 40 }, { page_index: 1, field_type: 'date', x: 50, y: 100, width: 100, height: 20 }],
    });
    const before = w.emails.length;
    await call(createSendEnvelopeHandler({ ...ownerDeps, storage: w.storage, pdf, loadOrg: w.loadOrg, sendEmail: w.sendEmail, siteUrl: SITE_URL, smsEnv: { production: false, twilioConfigured: false } }), { envelope_id: created.id });
    const token = /#token=([A-Za-z0-9_-]+)/.exec(w.emails[before].text)?.[1] as string;

    const ip = { 'cf-connecting-ip': SIGNER_IP };
    const publicDeps = { ...base, rateLimit: async () => 'allowed' as const };
    const resolved = await (await call(createResolveTokenHandler(publicDeps), { token }, ip)).json();
    expect(resolved).toMatchObject({ state: 'ok', signer: { first_name: 'Ada', last_name: 'Lovelace' }, document: { page_count: 2 } });
    await call(createSignerViewPdfHandler({ ...publicDeps, storage: w.storage }), { token, consent: true, consent_version: 'v1.0' }, ip);

    const finalizeHandler = createFinalizeEnvelopeHandler(deps());
    const trigger = async (envelopeId: string) => (await finalizeHandler(edgeRequest({ origin: null, headers: INTERNAL, body: { envelope_id: envelopeId } }))).ok;
    const signed = await (
      await call(createSignerSignHandler({ ...publicDeps, pdf, finalize: trigger }), { token, consent: true, kind: 'drawn', signature_image: await drawnSignaturePng(), timezone: 'Europe/London' }, ip)
    ).json();
    expect(signed).toEqual({ ok: true, finalized: true });

    const [env] = await w.q<{ signed_pdf_path: string; signed_pdf_sha256: string }>(`SELECT signed_pdf_path, signed_pdf_sha256 FROM public.esign_envelopes WHERE id = $1`, [created.id]);
    const executed = w.storage.documents.get(env.signed_pdf_path) as Uint8Array;
    const verified = await (await call(createVerifyDocumentHandler(publicDeps), { sha256: await sha256Bytes(executed) }, {})).json();
    expect(verified).toMatchObject({ verified: true, title: 'Flow lease', signers: [{ name: 'Ada Lovelace', status: 'signed' }] });
    const tampered = new Uint8Array(executed);
    tampered[tampered.length - 10] ^= 1;
    expect((await (await call(createVerifyDocumentHandler(publicDeps), { sha256: await sha256Bytes(tampered) }, {})).json()).verified).toBe(false);
  });
});

describe('the executed audit trail', () => {
  it('collapses a signer’s many link opens into one line with the count, first and last time', async () => {
    const { envelopeId, signers } = await allSigned();
    for (let i = 0; i < 50; i += 1) {
      await w.q(
        `INSERT INTO public.esign_envelope_events (envelope_id, signer_id, event_type, created_at) VALUES ($1, $2, 'signer_opened_link', now() - make_interval(mins => $3))`,
        [envelopeId, signers[0].id, 60 - i],
      );
    }
    await w.q(`INSERT INTO public.esign_envelope_events (envelope_id, signer_id, event_type) VALUES ($1, $2, 'signer_opened_link')`, [envelopeId, signers[1].id]);
    const tools = pdfTools(true);
    let trail: ReadonlyArray<{ phrase: string }> = [];
    const res = await finalize(envelopeId, deps({
      pdf: { ...tools, stampAndAudit: async (o) => { trail = o.events; return tools.stampAndAudit(o); } },
    }));
    expect(res.status).toBe(200);
    const opens = trail.map((e) => e.phrase).filter((p) => p.includes('opened the sign link'));
    expect(opens).toHaveLength(2);
    expect(opens[0]).toMatch(/^Ada Lovelace \(ada@example\.com\) opened the sign link 50 times, first at .+, last at .+\.$/);
    expect(opens[1]).toBe('Byron Lord (byron@example.com) opened the sign link.');
  });
});

describe('stamping on a rotated page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface Drawn {
    label: string;
    angle: number;
    corners: Array<[number, number]>;
  }

  /** What one stampAndAudit drew, each item as the four corners of its rectangle in user space. */
  async function stampOnce(rotation: number, kind: 'typed' | 'drawn', sig: StampBox, date: StampBox): Promise<Drawn[]> {
    const doc = await pdfLib.PDFDocument.create();
    doc.addPage([612, 792]).setRotation(pdfLib.degrees(rotation));
    const sourcePdf = await doc.save();
    const text = vi.spyOn(pdfLib.PDFPage.prototype, 'drawText');
    const image = vi.spyOn(pdfLib.PDFPage.prototype, 'drawImage');
    const base = { signer_id: 's1', signer_name: 'Ada Lovelace', signed_at: new Date('2026-10-15T12:00:00Z'), tz: 'UTC',
      fields: [{ page_index: 0, field_type: 'signature' as const, ...sig }, { page_index: 0, field_type: 'date' as const, ...date }] };
    const signer: SignerStamp = kind === 'typed'
      ? { ...base, kind: 'typed', signature_text: 'Ada Lovelace', font_key: 'great_vibes' }
      : { ...base, kind: 'drawn', image_base64: await drawnSignaturePng() };
    await pdfTools(true).stampAndAudit({
      orgName: 'Acme LLC', siteUrl: SITE_URL, sourcePdf, envelopeIdShort: 'abcd1234', completedAtIso: '2026-10-15T12:00:00Z',
      signers: [signer], signerSummaries: [], events: [],
    });
    const corners = (x: number, y: number, w: number, h: number, deg: number): Array<[number, number]> => {
      const t = (deg * Math.PI) / 180;
      return ([[0, 0], [w, 0], [0, h], [w, h]] as Array<[number, number]>).map(([u, v]) => [x + u * Math.cos(t) - v * Math.sin(t), y + u * Math.sin(t) + v * Math.cos(t)]);
    };
    const out: Drawn[] = [];
    for (const [t, o] of text.mock.calls as unknown as Array<[string, { x: number; y: number; size: number; font: { widthOfTextAtSize(t: string, s: number): number }; rotate?: { angle: number }; maxWidth?: number }]>) {
      const label = t === 'Ada Lovelace' ? 'signature' : t.startsWith('e-Signed by') ? 'caption' : /^\d\d\/\d\d\/\d{4}$/.test(t) ? 'date' : '';
      if (!label) continue;
      const w = Math.min(o.font.widthOfTextAtSize(t, o.size), o.maxWidth ?? Infinity);
      out.push({ label, angle: o.rotate?.angle ?? 0, corners: corners(o.x, o.y, w, o.size, o.rotate?.angle ?? 0) });
    }
    for (const [, o] of image.mock.calls as unknown as Array<[unknown, { x: number; y: number; width: number; height: number; rotate?: { angle: number } }]>) {
      out.push({ label: 'signature', angle: o.rotate?.angle ?? 0, corners: corners(o.x, o.y, o.width, o.height, o.rotate?.angle ?? 0) });
    }
    return out;
  }

  type StampBox = { x: number; y: number; width: number; height: number };
  /** The same boxes as a reader sees them (wide), stored unrotated: tall on a sideways page. */
  const stored = (b: StampBox, rotation: number): StampBox => (rotation % 180 === 0 ? b : { x: b.x, y: b.y, width: b.height, height: b.width });

  for (const rotation of [0, 90, 180, 270]) {
    for (const kind of ['typed', 'drawn'] as const) {
      it(`a ${kind} signature and its date read upright inside their boxes at /Rotate ${rotation}`, async () => {
        const sig = stored({ x: 100, y: 200, width: 180, height: 50 }, rotation);
        const date = stored({ x: 300, y: 500, width: 100, height: 20 }, rotation);
        const drawn = await stampOnce(rotation, kind, sig, date);
        expect(drawn.map((d) => d.label).sort()).toEqual(['caption', 'date', 'signature']);
        for (const d of drawn) {
          const b = d.label === 'date' ? date : sig;
          // Turned with the page, so it cancels the viewer's turn.
          expect([d.label, d.angle]).toEqual([d.label, rotation]);
          for (const [x, y] of d.corners) {
            expect([d.label, x >= b.x - 0.5 && x <= b.x + b.width + 0.5, y >= b.y - 0.5 && y <= b.y + b.height + 0.5]).toEqual([d.label, true, true]);
          }
        }
        // The signature and caption fill the box, not a corner of it.
        const all = drawn.filter((d) => d.label !== 'date').flatMap((d) => d.corners);
        const spanX = Math.max(...all.map((c) => c[0])) - Math.min(...all.map((c) => c[0]));
        const spanY = Math.max(...all.map((c) => c[1])) - Math.min(...all.map((c) => c[1]));
        expect(spanX).toBeGreaterThan(sig.width * 0.6);
        expect(spanY).toBeGreaterThan(sig.height * 0.6);
      });
    }
  }
});
