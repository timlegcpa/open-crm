// esign-send-envelope: check a draft, assemble the final PDF, invite every signer.
// Owner only.
//
// In order:
//   1. The draft must be sendable: pages, signers, a required field per signer, every
//      field on a real page, a phone per signer for 'high' (and text messages available).
//      Problems come back together, 400 with a `validation` list.
//   2. The live pages are assembled into {envelope}/source.pdf, and its SHA-256 is kept:
//      the exact bytes every signer reviews. Above 24 MB it is refused, so the executed
//      copy (source plus the audit pages) still fits the documents store's limit.
//   3. draft -> sent is CLAIMED with a status guard before any signer is touched: a
//      double click loses the claim and sends nothing twice.
//   4. Per signer: a fresh link token (only its SHA-256 is stored), a portal task when
//      the signer's contact has an active portal account (the task links by signer id and
//      carries no token: the portal exchanges it after checking the login email), and the
//      invitation. A signer whose token write or email failed is listed in failed_emails;
//      Resend invite recovers each one.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import { allRows, maybeOne, rows } from '../esign-finalize-envelope/lib/db.ts';
import { inviteEmail } from '../esign-finalize-envelope/lib/emails.ts';
import { badRequest, envelopeNotFound, notDraft, objectBody, smsUnavailable } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { createMailer, type MailDeps } from '../esign-finalize-envelope/lib/mail.ts';
import { planMerge, sha256Bytes, type PdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import { loadEsignSettings, smsAvailable } from '../esign-finalize-envelope/lib/settings.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';
import type { EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';
import { DAY_MS, newToken, SIGNING_LINK_DAYS, signingUrl } from '../esign-finalize-envelope/lib/text.ts';

export interface SendEnvelopeRequest {
  envelope_id: string;
}

export interface SendEnvelopeResponse {
  ok: true;
  envelope_id: string;
  signers_invited: number;
  /** Signers whose link or email did not go out; Resend invite recovers each. */
  failed_emails: string[];
}

/** The 400 when the draft is not ready: one sentence, plus every problem. */
export interface SendValidationError {
  error: string;
  code: 'validation_failed';
  validation: string[];
}

export const SEND_ENVELOPE_ERRORS = ['bad_request', 'validation_failed', 'too_large', 'sms_unavailable', 'site_url_missing', 'not_found', 'not_draft'] as const;

/** Leaves the executed copy (this plus the audit pages) room under the 25 MiB store limit. */
export const MAX_ASSEMBLED_BYTES = 24 * 1024 * 1024;
const MAX_LIVE_PAGES = 200;

export interface SendEnvelopeDeps extends MailDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  storage: EsignStorage;
  pdf: Pick<PdfTools, 'assemblePdf'>;
  siteUrl: string | null;
  smsEnv: { production: boolean; twilioConfigured: boolean };
  now?: () => Date;
  logSink?: LogSink;
}

interface PageRow {
  id: string;
  order: number;
  source_document_id: string;
  source_page_index: number;
  deleted: boolean;
}
interface SignerRow {
  id: string;
  contact_id: string | null;
  email: string;
  order: number;
  role: string;
  phone_last_four: string | null;
}
interface FieldRow {
  id: string;
  signer_id: string;
  page_index: number;
  required: boolean;
}

export function createSendEnvelopeHandler(deps: SendEnvelopeDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-send-envelope',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const envelopeId = objectBody(body).envelope_id;
      if (!isUuid(envelopeId)) throw badRequest();
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; a signing link cannot be built');
        throw new HttpError(500, 'Signing links are not set up on this server yet (SITE_URL).', 'site_url_missing');
      }

      const envelope = await maybeOne<{ id: string; title: string; status: string; verification_level: 'standard' | 'high' }>(
        'envelope read',
        db.from('esign_envelopes').select('id, title, status, verification_level').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status !== 'draft') throw notDraft();
      const high = envelope.verification_level === 'high';
      if (high && !smsAvailable(await loadEsignSettings(db), deps.smsEnv)) throw smsUnavailable();

      const [pages, documents, signers, fields] = await Promise.all([
        allRows<PageRow>('page read', () =>
          db.from('esign_envelope_pages').select('id, order, source_document_id, source_page_index, deleted').eq('envelope_id', envelopeId).eq('deleted', false)),
        rows<{ id: string; storage_path: string }>('document read', db.from('esign_envelope_documents').select('id, storage_path').eq('envelope_id', envelopeId)),
        allRows<SignerRow>('signer read', () =>
          db.from('esign_envelope_signers').select('id, contact_id, email, order, role, phone_last_four').eq('envelope_id', envelopeId)),
        allRows<FieldRow>('field read', () => db.from('esign_envelope_fields').select('id, signer_id, page_index, required').eq('envelope_id', envelopeId)),
      ]);
      signers.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

      // 1. Everything wrong at once.
      const problems: string[] = [];
      if (pages.length === 0) problems.push('At least one page is required.');
      if (pages.length > MAX_LIVE_PAGES) problems.push('An envelope can hold at most 200 pages.');
      if (signers.length === 0) problems.push('At least one signer is required.');
      const required = new Map<string, number>();
      for (const f of fields) if (f.required) required.set(f.signer_id, (required.get(f.signer_id) ?? 0) + 1);
      for (const s of signers) if (!required.get(s.id)) problems.push(`Signer ${s.email} has no required fields.`);
      const badIndexes = [...new Set(fields.filter((f) => f.page_index >= pages.length).map((f) => f.page_index))];
      for (const i of badIndexes) problems.push(`A field is on page ${i + 1}, which this envelope does not have.`);
      if (high) for (const s of signers) if (!s.phone_last_four) problems.push(`Signer ${s.email} needs a phone number for text message verification.`);
      if (problems.length > 0) {
        const response: SendValidationError = {
          error: problems.length === 1 ? problems[0] : `This envelope has ${problems.length} problems to fix before it can be sent.`,
          code: 'validation_failed',
          validation: problems,
        };
        return json(400, response);
      }

      // The sender's identity before anything changes, so a failure here leaves a draft.
      const mailer = await createMailer(deps, log);

      // 2. The final document.
      const plan = planMerge(pages);
      const referenced = new Set(plan.map((p) => p.source_document_id));
      const sources: Array<{ id: string; bytes: Uint8Array }> = [];
      for (const doc of documents) {
        if (referenced.has(doc.id)) sources.push({ id: doc.id, bytes: await deps.storage.getWorking(doc.storage_path) });
      }
      const assembled = await deps.pdf.assemblePdf(plan, sources);
      if (assembled.byteLength > MAX_ASSEMBLED_BYTES) {
        throw new HttpError(413, 'The assembled document is over 24 MB. Remove pages or use smaller files.', 'too_large');
      }
      const sourcePath = `${envelopeId}/source.pdf`;
      await deps.storage.putWorking(sourcePath, assembled, { upsert: true });
      const sourceSha256 = await sha256Bytes(assembled);

      // 3. The claim, with the source recorded in the same write.
      const sentAt = now();
      const expiresAt = new Date(sentAt.getTime() + SIGNING_LINK_DAYS * DAY_MS).toISOString();
      const claimed = await rows(
        'envelope claim',
        db
          .from('esign_envelopes')
          .update({ status: 'sent', sent_at: sentAt.toISOString(), expires_at: expiresAt, source_pdf_path: sourcePath, source_pdf_sha256: sourceSha256 })
          .eq('id', envelopeId)
          .eq('status', 'draft')
          .select('id'),
      );
      if (claimed.length === 0) throw notDraft();

      const contactIds = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
      const contacts = contactIds.length
        ? await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', contactIds))
        : [];
      const contactById = new Map(contacts.map((c) => [c.id, c]));

      // 4. Each signer.
      let invited = 0;
      const failed: string[] = [];
      for (const signer of signers) {
        const { token, hash } = await newToken();
        const write = await db
          .from('esign_envelope_signers')
          .update({ token_hash: hash, token_expires_at: expiresAt, status: 'invited', invited_at: sentAt.toISOString() })
          .eq('id', signer.id);
        if (write.error) {
          // The signer stays pending with no link; Resend invite recovers it.
          log.error('signer token write failed', write.error, { signer_id: signer.id });
          failed.push(signer.email);
          continue;
        }

        if (signer.contact_id) await createPortalTask(signer, envelope.title, log);

        const contact = signer.contact_id ? contactById.get(signer.contact_id) ?? null : null;
        const name = contact ? resolveSignerName({ email: signer.email, role: signer.role, contact }) : null;
        const status = await mailer.send(
          signer.email,
          inviteEmail({ org: mailer.org, recipientName: name === signer.email ? null : name, title: envelope.title, url: signingUrl(deps.siteUrl, token), high }),
          { tags: { esign_signer_id: signer.id, kind: 'esign_invite' }, idempotencyKey: `esign-invite:${signer.id}:${hash.slice(0, 16)}` },
        );
        if (status !== 'sent') {
          failed.push(signer.email);
          continue;
        }
        await recordEvent(db, log, { envelope_id: envelopeId, signer_id: signer.id, event_type: 'invite_sent', metadata: { email: signer.email } });
        invited += 1;
      }

      await recordEvent(db, log, {
        envelope_id: envelopeId,
        event_type: 'envelope_sent',
        ip,
        user_agent: userAgent,
        metadata: { signers_invited: invited, invite_failures: failed.length, source_pdf_sha256: sourceSha256 },
      });
      const response: SendEnvelopeResponse = { ok: true, envelope_id: envelopeId, signers_invited: invited, failed_emails: failed };
      return json(200, response);
    },
  });

  /** Best effort: a "Signature needed" task for a signer with an active portal account. */
  async function createPortalTask(signer: SignerRow, title: string, log: Logger) {
    try {
      const account = await maybeOne(
        'portal account read',
        db.from('client_portal_accounts').select('id').eq('contact_id', signer.contact_id).eq('status', 'active').limit(1).maybeSingle(),
      );
      if (!account) return;
      const task = await maybeOne<{ id: string }>(
        'task insert',
        db
          .from('client_tasks')
          .insert({
            contact_id: signer.contact_id,
            title: `Sign: ${title}`.slice(0, 200),
            link: `/portal/sign?signer=${signer.id}`,
            type: 'esign',
            status: 'pending',
          })
          .select('id')
          .single(),
      );
      if (task) {
        const link = await db.from('esign_envelope_signers').update({ client_task_id: task.id }).eq('id', signer.id);
        if (link.error) log.error('task link failed', link.error, { signer_id: signer.id });
      }
    } catch (err) {
      log.error('portal task not created', err, { signer_id: signer.id });
    }
  }
}
