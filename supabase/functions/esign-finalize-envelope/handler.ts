// esign-finalize-envelope: turn an envelope every signer signed into the executed copy.
// Internal only (x-internal-token, ESIGN_INTERNAL_TOKEN): sign calls it after the last
// signature, and the daily expiry run re-drives an envelope a failed call left behind.
//
// In order:
//   1. Every signer has signed, with a signature finalize can draw (a typed text and font,
//      or a stored drawn image). Anything less is 409 and nothing changes.
//   2. The source is stamped (signatures, dates, captions), the audit trail is appended,
//      and a footer goes on every page. The fonts were proven at sign time, so this does
//      not fail on a glyph.
//   3. The executed copy is stored ONCE at {owner contact}/esign/{envelope}.pdf. When the
//      path is taken, another finalize won: its bytes are read back and hashed, so the
//      digest recorded is always the digest of the file people hold.
//   4. completed is CLAIMED with a status guard, setting all four frozen fields at once
//      (the database refuses any later change to them). Losing the claim means another
//      call completed it: answered as already completed.
//   5. Deliverables, each idempotent and recorded on the envelope: the filing folder
//      (from settings) for each signer's contact and one documents row per contact over
//      the ONE object (unique per envelope and contact, so racing runs file once), the
//      completion event once, and the copy emailed to every signer and the owner, each
//      party recorded in `delivery` once sent (and sent with a per-party idempotency key).
//      delivered_at is set when all of it is done. A completed envelope that comes back
//      here (a crash, a failed email) re-drives this step alone, skipping what is done;
//      the daily expiry run brings back any completed envelope still undelivered.

import { sha256Hex } from '../_shared/crypto.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import { allRows, byTimeThenId, maybeOne, rows, run, type Row } from './lib/db.ts';
import { completedEmail } from './lib/emails.ts';
import { badRequest, envelopeNotFound, objectBody } from './lib/errors.ts';
import { auditTrail } from './lib/events.ts';
import { createMailer, type MailDeps } from './lib/mail.ts';
import { sha256Bytes, type PdfTools, type SignerFontKey, type SignerStamp, type StampField } from './lib/pdf.ts';
import { consentLine, identityCheckLine } from './lib/phone.ts';
import { loadEsignSettings, pdfOrgName } from './lib/settings.ts';
import { LIVE_ENVELOPE } from './lib/signer-access.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from './lib/signer-name.ts';
import type { EsignStorage } from './lib/storage.ts';
import { esignSafeFilename } from './lib/text.ts';
import { isSignerFontKey } from './lib/typed-signature.ts';

export interface FinalizeEnvelopeRequest {
  envelope_id: string;
}

export type FinalizeEnvelopeResponse =
  | { ok: true; signed_pdf_path: string; sha256: string }
  | { ok: true; already_completed: true; signed_pdf_path: string | null }
  | { ok: true; recovered: true; delivered: boolean; signed_pdf_path: string };

export const FINALIZE_ENVELOPE_ERRORS = ['bad_request', 'not_found', 'not_finalizable', 'not_all_signed', 'no_owner_contact', 'site_url_missing'] as const;

export interface FinalizeEnvelopeDeps extends MailDeps {
  allowedOrigins: string[];
  internalToken: string | null;
  storage: Pick<EsignStorage, 'getWorking' | 'putDocument' | 'getDocument'>;
  pdf: Pick<PdfTools, 'stampAndAudit'>;
  ownerEmail(): Promise<string | null>;
  siteUrl: string | null;
  now?: () => Date;
  logSink?: LogSink;
}

interface EnvelopeRow {
  id: string;
  title: string;
  status: string;
  primary_contact_id: string | null;
  source_pdf_path: string | null;
  signed_pdf_path: string | null;
  signed_pdf_sha256: string | null;
  delivery: { emails?: Record<string, string> } | null;
  delivery_attempts: number;
  delivered_at: string | null;
}

interface SignerRow {
  id: string;
  contact_id: string | null;
  email: string;
  role: string;
  order: number;
  status: string;
  signed_at: string | null;
  signed_signature_kind: string | null;
  signed_signature_text: string | null;
  signed_font: string | null;
  signed_timezone: string | null;
  signed_verification_method: string | null;
  consented_at: string | null;
  consent_disclosure_version: string | null;
  phone_last_four: string | null;
}

const SIGNER_COLUMNS =
  'id, contact_id, email, role, order, status, signed_at, signed_signature_kind, signed_signature_text, signed_font, signed_timezone, ' +
  'signed_verification_method, consented_at, consent_disclosure_version, phone_last_four';

const notAllSigned = () => new HttpError(409, 'Not every signer has signed yet.', 'not_all_signed');

/** A title as a file name the documents store accepts: no separators, controls or format characters. */
export function executedFileTitle(title: string): string {
  const cleaned = esignSafeFilename(title).replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return cleaned || 'Signed document';
}

export function createFinalizeEnvelopeHandler(deps: FinalizeEnvelopeDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-finalize-envelope',
    allowedOrigins: deps.allowedOrigins,
    auth: { internal: { header: 'x-internal-token', secret: deps.internalToken } },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ body, json, log }) {
      const envelopeId = objectBody(body).envelope_id;
      if (!isUuid(envelopeId)) throw badRequest();
      const envelope = await maybeOne<EnvelopeRow>(
        'envelope read',
        db
          .from('esign_envelopes')
          .select('id, title, status, primary_contact_id, source_pdf_path, signed_pdf_path, signed_pdf_sha256, delivery, delivery_attempts, delivered_at')
          .eq('id', envelopeId)
          .maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      const signers = await allRows<SignerRow>('signer read', () =>
        db.from('esign_envelope_signers').select(SIGNER_COLUMNS).eq('envelope_id', envelope.id));
      signers.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
      const contacts = await contactsOf(signers);
      const nameOf = (s: SignerRow) => resolveSignerName({ email: s.email, role: s.role, contact: s.contact_id ? contacts.get(s.contact_id) ?? null : null });

      // A completed envelope: re-drive whatever of the delivery is not done yet.
      if (envelope.status === 'completed') {
        if (!envelope.signed_pdf_path || !envelope.signed_pdf_sha256 || envelope.delivered_at) {
          return json(200, { ok: true, already_completed: true, signed_pdf_path: envelope.signed_pdf_path } satisfies FinalizeEnvelopeResponse);
        }
        const stored = await deps.storage.getDocument(envelope.signed_pdf_path);
        const delivered = await deliver(log, envelope, signers, nameOf, envelope.signed_pdf_path, envelope.signed_pdf_sha256, stored);
        return json(200, { ok: true, recovered: true, delivered, signed_pdf_path: envelope.signed_pdf_path } satisfies FinalizeEnvelopeResponse);
      }
      if (!(LIVE_ENVELOPE as readonly string[]).includes(envelope.status)) {
        throw new HttpError(409, 'This envelope is not waiting for signatures.', 'not_finalizable');
      }
      if (!envelope.source_pdf_path) throw new Error('a live envelope has no source document');
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; the audit trail cannot name the verify page');
        throw new HttpError(500, 'Signing links are not set up on this server yet (SITE_URL).', 'site_url_missing');
      }

      // 1. Everyone signed, with something to draw.
      if (signers.length === 0) throw notAllSigned();
      const drawnIds = signers.filter((s) => s.signed_signature_kind === 'drawn').map((s) => s.id);
      const images = new Map<string, string>();
      if (drawnIds.length > 0) {
        const found = await rows<{ signer_id: string; image_base64: string }>(
          'signature image read',
          db.from('esign_signer_signature_images').select('signer_id, image_base64').in('signer_id', drawnIds),
        );
        for (const r of found) images.set(r.signer_id, r.image_base64);
      }
      for (const s of signers) {
        if (s.status !== 'signed' || !s.signed_at) throw notAllSigned();
        const drawable = s.signed_signature_kind === 'drawn' ? images.has(s.id) : !!s.signed_signature_text && isSignerFontKey(s.signed_font);
        if (!drawable) throw notAllSigned();
      }

      const ownerContactId = envelope.primary_contact_id ?? signers.map((s) => s.contact_id).find((id): id is string => !!id) ?? null;
      if (!ownerContactId) {
        log.error('no contact can hold the executed copy', undefined, { envelope_id: envelope.id });
        throw new HttpError(409, 'No signer on this envelope is linked to a contact, so the signed copy has nowhere to be filed.', 'no_owner_contact');
      }

      // 2. Stamp.
      const [fields, events, org] = await Promise.all([
        allRows<{ id: string; signer_id: string } & StampField>('field read', () =>
          db.from('esign_envelope_fields').select('id, signer_id, page_index, field_type, x, y, width, height').eq('envelope_id', envelope.id)),
        allRows<{ id: string; signer_id: string | null; event_type: string; ip: string | null; metadata: Row | null; created_at: string }>(
          'event read',
          () => db.from('esign_envelope_events').select('id, signer_id, event_type, ip, metadata, created_at').eq('envelope_id', envelope.id),
        ),
        deps.loadOrg(),
      ]);
      const source = await deps.storage.getWorking(envelope.source_pdf_path);
      const completedAt = now().toISOString();
      const short = envelope.id.replace(/-/g, '').slice(0, 8);
      const byId = new Map(signers.map((s) => [s.id, s]));

      const stamps: SignerStamp[] = signers.map((s) => {
        const base = {
          signer_id: s.id,
          signer_name: nameOf(s),
          signed_at: new Date(s.signed_at as string),
          tz: s.signed_timezone ?? undefined,
          fields: fields
            .filter((f) => f.signer_id === s.id)
            .map((f) => ({ page_index: f.page_index, field_type: f.field_type, x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) })),
        };
        if (s.signed_signature_kind === 'drawn') return { ...base, kind: 'drawn', image_base64: images.get(s.id) as string };
        return { ...base, kind: 'typed', signature_text: s.signed_signature_text as string, font_key: s.signed_font as SignerFontKey };
      });
      let pdf = await deps.pdf.stampAndAudit({
        orgName: pdfOrgName(org),
        siteUrl: deps.siteUrl,
        sourcePdf: source,
        envelopeIdShort: short,
        completedAtIso: completedAt,
        signers: stamps,
        signerSummaries: signers.map((s) => ({
          name: nameOf(s),
          email: s.email,
          identity_check: identityCheckLine(s),
          tz: s.signed_timezone ?? undefined,
          consent: consentLine(s),
          signature_type: s.signed_signature_kind === 'drawn' ? 'Drawn' : 'Typed',
        })),
        events: auditTrail(events.sort(byTimeThenId), (signerId) => {
          const s = signerId ? byId.get(signerId) : undefined;
          const contact = s?.contact_id ? contacts.get(s.contact_id) ?? null : null;
          return s ? { email: s.email, role: s.role, contact } : undefined;
        }),
      });

      // 3. Store once.
      const signedPath = `${ownerContactId}/esign/${envelope.id}.pdf`;
      if ((await deps.storage.putDocument(signedPath, pdf)) === 'exists') pdf = await deps.storage.getDocument(signedPath);
      const sha256 = await sha256Bytes(pdf);

      // 4. Claim.
      const claimed = await rows(
        'completion claim',
        db
          .from('esign_envelopes')
          .update({ status: 'completed', completed_at: completedAt, signed_pdf_path: signedPath, signed_pdf_sha256: sha256 })
          .eq('id', envelope.id)
          .in('status', [...LIVE_ENVELOPE])
          .select('id'),
      );
      if (claimed.length === 0) {
        return json(200, { ok: true, already_completed: true, signed_pdf_path: signedPath } satisfies FinalizeEnvelopeResponse);
      }

      // 5. Deliver.
      await deliver(log, envelope, signers, nameOf, signedPath, sha256, pdf);
      return json(200, { ok: true, signed_pdf_path: signedPath, sha256 } satisfies FinalizeEnvelopeResponse);
    },
  });

  async function contactsOf(signers: readonly SignerRow[]): Promise<Map<string, SignerContact>> {
    const ids = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const found = await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', ids));
    return new Map(found.map((c) => [c.id, c]));
  }

  /**
   * Files the executed copy and sends it, skipping whatever an earlier run finished, and
   * records the outcome on the envelope. True when everything is now delivered.
   */
  async function deliver(
    log: Logger,
    envelope: EnvelopeRow,
    signers: readonly SignerRow[],
    nameOf: (s: SignerRow) => string,
    signedPath: string,
    sha256: string,
    pdf: Uint8Array,
  ): Promise<boolean> {
    const fileTitle = executedFileTitle(envelope.title);
    let complete = true;

    // a. Filing. Contacts deleted since (contact_id SET NULL) are skipped: a documents row
    // needs one. The unique (esign_envelope_id, contact_id) makes a racing run's row a no-op.
    try {
      const contactIds = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
      if (contactIds.length > 0) {
        const chain = (await loadEsignSettings(db)).filingFolder;
        const folderRows: Row[] = [];
        for (const contactId of contactIds) {
          chain.forEach((name, i) => {
            folderRows.push({ contact_id: contactId, parent_path: i === 0 ? '/' : `/${chain.slice(0, i).join('/')}/`, name, held_by: 'owner' });
          });
        }
        await run(
          'filing folder upsert',
          db.from('client_folders').upsert(folderRows, { onConflict: 'contact_id,parent_path,name,held_by', ignoreDuplicates: true }),
        );
        await run(
          'filed copy insert',
          db.from('client_documents').upsert(
            contactIds.map((contactId) => ({
              contact_id: contactId,
              uploaded_by: null,
              filename: `${envelope.id}.pdf`,
              original_filename: `${fileTitle}.pdf`,
              storage_path: signedPath,
              file_size: pdf.byteLength,
              mime_type: 'application/pdf',
              folder_path: `/${chain.join('/')}/`,
              held_by: 'owner',
              // Honest: the executed copy is plaintext, served by a short signed URL.
              encryption_status: 'none',
              esign_envelope_id: envelope.id,
            })),
            { onConflict: 'esign_envelope_id,contact_id', ignoreDuplicates: true },
          ),
        );
      }
    } catch (err) {
      complete = false;
      log.error('executed copy not filed; the expiry run retries', err, { envelope_id: envelope.id });
    }

    // b. The completion event, once.
    try {
      const done = await rows(
        'completion event read',
        db.from('esign_envelope_events').select('id').eq('envelope_id', envelope.id).eq('event_type', 'envelope_completed').limit(1),
      );
      if (done.length === 0) {
        await run(
          'completion event insert',
          db.from('esign_envelope_events').insert({ envelope_id: envelope.id, event_type: 'envelope_completed', metadata: { signed_pdf_path: signedPath, sha256 } }),
        );
      }
    } catch (err) {
      complete = false;
      log.error('completion event failed', err, { envelope_id: envelope.id });
    }

    // c. Each party's email, once: a party already recorded is skipped.
    const sent: Record<string, string> = { ...(envelope.delivery?.emails ?? {}) };
    try {
      const mailer = await createMailer(deps, log);
      const recipients = signers.map((s) => ({ email: s.email, name: nameOf(s) as string | null }));
      const owner = await deps.ownerEmail();
      if (owner && !recipients.some((r) => r.email === owner.toLowerCase())) recipients.push({ email: owner, name: null });
      for (const r of recipients) {
        const party = await sha256Hex(r.email.trim().toLowerCase());
        if (sent[party]) continue;
        const status = await mailer.send(r.email, completedEmail({ org: mailer.org, recipientName: r.name === r.email ? null : r.name, title: envelope.title }), {
          attachments: [{ filename: `${fileTitle}_signed.pdf`, content: pdf }],
          tags: { envelope_id: envelope.id, kind: 'esign_completed' },
          idempotencyKey: `esign_completed:${envelope.id}:${await sha256Hex(r.email)}`,
        });
        if (status === 'sent') {
          sent[party] = now().toISOString();
        } else {
          complete = false;
          log.warn('completion email not sent', { envelope_id: envelope.id });
        }
      }
    } catch (err) {
      complete = false;
      log.error('completion emails not sent', err, { envelope_id: envelope.id });
    }

    // d. The record the expiry run reads.
    try {
      await run(
        'delivery record',
        db
          .from('esign_envelopes')
          .update({ delivery: { emails: sent }, delivery_attempts: envelope.delivery_attempts + 1, delivered_at: complete ? now().toISOString() : null })
          .eq('id', envelope.id),
      );
    } catch (err) {
      log.error('delivery record not written; the expiry run re-checks', err, { envelope_id: envelope.id });
    }
    return complete;
  }
}
