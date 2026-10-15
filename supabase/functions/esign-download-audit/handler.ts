// esign-download-audit: the audit trail of any envelope past draft, as a PDF. Owner only.
//
// The same audit page finalize appends to the executed copy, rendered alone, with the
// generation time in the subtitle. It runs on envelopes still in progress, so a signer
// who has not signed gets no "Signature Type" line: an audit trail asserts only what it
// knows. Events are read in full (paged by id) and then put in time order.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import { allRows, byTimeThenId, maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { EVENT_LABELS, type EventType } from '../esign-finalize-envelope/lib/events.ts';
import type { PdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import { consentLine, identityCheckLine } from '../esign-finalize-envelope/lib/phone.ts';
import { pdfOrgName } from '../esign-finalize-envelope/lib/settings.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';

export interface DownloadAuditRequest {
  envelope_id: string;
}

/** The response is the PDF itself (application/pdf, attachment audit-<id>.pdf). */
export type DownloadAuditResponse = Uint8Array;

export const DOWNLOAD_AUDIT_ERRORS = ['bad_request', 'draft', 'not_found'] as const;

export interface DownloadAuditDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  pdf: Pick<PdfTools, 'renderAuditOnly'>;
  loadOrg(): Promise<OrgIdentity>;
  siteUrl: string | null;
  now?: () => Date;
  logSink?: LogSink;
}

interface SignerRow {
  id: string;
  contact_id: string | null;
  email: string;
  role: string;
  order: number;
  status: string;
  signed_verification_method: string | null;
  signed_signature_kind: string | null;
  signed_timezone: string | null;
  consented_at: string | null;
  consent_disclosure_version: string | null;
  phone_last_four: string | null;
}

export function createDownloadAuditHandler(deps: DownloadAuditDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-download-audit',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ body }) {
      const envelopeId = objectBody(body).envelope_id;
      if (!isUuid(envelopeId)) throw badRequest();
      const envelope = await maybeOne<{ id: string; status: string }>(
        'envelope read',
        db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status === 'draft') throw new HttpError(409, 'This envelope has not been sent yet, so it has no audit trail.', 'draft');

      const [signers, events, org] = await Promise.all([
        rows<SignerRow>(
          'signer read',
          db
            .from('esign_envelope_signers')
            .select('id, contact_id, email, role, order, status, signed_verification_method, signed_signature_kind, signed_timezone, consented_at, consent_disclosure_version, phone_last_four')
            .eq('envelope_id', envelopeId)
            .order('order')
            .order('id'),
        ),
        allRows<{ id: string; event_type: string; ip: string | null; created_at: string }>('event read', () =>
          db.from('esign_envelope_events').select('id, event_type, ip, created_at').eq('envelope_id', envelopeId)),
        deps.loadOrg(),
      ]);
      const contactIds = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
      const contacts = contactIds.length
        ? await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', contactIds))
        : [];
      const byId = new Map(contacts.map((c) => [c.id, c]));

      const short = envelope.id.replace(/-/g, '').slice(0, 8);
      const generatedAtIso = now().toISOString();
      const bytes = await deps.pdf.renderAuditOnly({
        orgName: pdfOrgName(org),
        siteUrl: deps.siteUrl ?? '',
        envelopeIdShort: short,
        generatedAtIso,
        signers: signers.map((s) => ({
          name: resolveSignerName({ email: s.email, role: s.role, contact: s.contact_id ? byId.get(s.contact_id) ?? null : null }),
          email: s.email,
          status: s.status,
          identity_check: identityCheckLine(s),
          tz: s.signed_timezone ?? undefined,
          consent: consentLine(s),
          signature_type: s.status !== 'signed' ? undefined : s.signed_signature_kind === 'drawn' ? 'Drawn' : 'Typed',
        })),
        events: events.sort(byTimeThenId).map((e) => ({
          created_at: e.created_at,
          phrase: EVENT_LABELS[e.event_type as EventType] ?? e.event_type,
          ip: e.ip,
        })),
      });
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="audit-${short}.pdf"`,
        },
      });
    },
  });
}
