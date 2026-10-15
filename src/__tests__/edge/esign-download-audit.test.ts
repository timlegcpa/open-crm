// @vitest-environment node
// esign-download-audit: any envelope past draft, as a PDF of its audit trail, with names
// resolved, the labels the owner's table shows, and nothing asserted for an unsigned signer.
import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { createDownloadAuditHandler, type DownloadAuditDeps } from '../../../supabase/functions/esign-download-audit/handler';
import { EVENT_LABELS, EVENT_TYPES } from '../../../supabase/functions/esign-finalize-envelope/lib/events';
import type { PdfTools } from '../../../supabase/functions/esign-finalize-envelope/lib/pdf';
import { CREDENTIALS, describeEdgeContract, edgeRequest, fakeOwnerAuth, throwInternal } from './contract';
import { createWorld, ORIGINS, pdfTools, seedContact, seedDraft, seedSentEnvelope, SITE_URL, type World } from './esign-world';

let w: World;
type AuditInput = Parameters<PdfTools['renderAuditOnly']>[0];

function deps(over: Partial<DownloadAuditDeps> = {}): DownloadAuditDeps {
  return {
    allowedOrigins: ORIGINS,
    authorizeOwner: fakeOwnerAuth(),
    db: w.db,
    pdf: pdfTools(),
    loadOrg: w.loadOrg,
    siteUrl: SITE_URL,
    now: () => new Date('2030-02-01T00:00:00Z'),
    logSink: w.logSink,
    ...over,
  };
}

const download = (envelopeId: string, d = deps()) =>
  createDownloadAuditHandler(d)(edgeRequest({ headers: CREDENTIALS.owner, body: { envelope_id: envelopeId } }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-download-audit', () => {
  describeEdgeContract({
    name: 'esign-download-audit',
    get handler() {
      return createDownloadAuditHandler(deps());
    },
    get failingHandler() {
      return createDownloadAuditHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    credentials: CREDENTIALS.owner,
    wrongPrincipal: CREDENTIALS.client,
    body: { kind: 'json', valid: { envelope_id: '10000000-0000-4000-8000-0000000000e1' }, maxBytes: 16_384 },
  });

  it('labels every event type', () => {
    expect(Object.keys(EVENT_LABELS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('answers the audit PDF as an attachment', async () => {
    const { envelopeId } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const res = await download(envelopeId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="audit-${envelopeId.replace(/-/g, '').slice(0, 8)}.pdf"`);
    const doc = await pdfLib.PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('passes resolved names, time-ordered labelled events, and a type only for signers who signed', async () => {
    const contactId = await seedContact(w, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', spouse_email: 'byron@example.com', spouse_first_name: 'Byron' });
    const { envelopeId, signers } = await seedSentEnvelope(w, {
      signers: [{ email: 'ada@example.com', contactId, role: 'primary' }, { email: 'byron@example.com', contactId, role: 'co_signer' }],
    });
    await w.q(`UPDATE public.esign_envelope_signers SET status = 'signed', signed_at = now(), signed_signature_kind = 'drawn' WHERE id = $1`, [signers[0].id]);
    await w.q(
      `INSERT INTO public.esign_envelope_events (envelope_id, event_type, ip, created_at) VALUES ($1, 'invite_sent', '203.0.113.9', '2030-01-02'), ($1, 'envelope_sent', NULL, '2030-01-01')`,
      [envelopeId],
    );
    let seen: AuditInput | undefined;
    const spy = deps({ pdf: { renderAuditOnly: async (input) => { seen = input; return new Uint8Array([37, 80, 68, 70]); } } });
    expect((await download(envelopeId, spy)).status).toBe(200);
    expect(seen?.orgName).toBe('Acme LLC');
    expect(seen?.siteUrl).toBe(SITE_URL);
    expect(seen?.generatedAtIso).toBe('2030-02-01T00:00:00.000Z');
    expect(seen?.signers.map((s) => [s.name, s.signature_type])).toEqual([['Ada Lovelace', 'Drawn'], ['Byron', undefined]]);
    expect(seen?.events.map((e) => [e.phrase, e.ip])).toEqual([['Envelope sent', null], ['Invite sent', '203.0.113.9']]);
  });

  it('refuses a draft and an unknown envelope', async () => {
    const draft = await seedDraft(w);
    const res = await download(draft.envelopeId);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('draft');
    expect((await download('10000000-0000-4000-8000-00000000dead')).status).toBe(404);
  });
});
