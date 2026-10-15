// esign-signer-view-pdf: the document a signer reviews, the exact assembled bytes. Public,
// rate limited.
//
// The page calls this only after the signer accepted the electronic-records disclosure,
// with consent: true and the disclosure version: the FIRST acceptance is recorded (its
// time and address, not the later sign click's) and never replaced. A 'high' envelope
// needs the SMS session first. The first view advances invited to viewed with a status
// guard, so a fast signer whose first view is still streaming is never set back from
// signed; signer_viewed_pdf is logged once.

import { createHandler } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { rows, type EsignDb, type Row } from '../esign-finalize-envelope/lib/db.ts';
import { linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { SIGNABLE_SIGNER } from '../esign-finalize-envelope/lib/signer-access.ts';
import { publicLimits, requireSessionIfHigh, requireSignable, type RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';
import type { EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';
import { consentVersionOf } from '../esign-finalize-envelope/lib/text.ts';

export interface SignerViewPdfRequest {
  token: string;
  /** Required for a 'high' envelope: the session verify-sms answered. */
  session_token?: string;
  consent?: boolean;
  consent_version?: string;
}

/** The response is the PDF itself (application/pdf). */
export type SignerViewPdfResponse = Uint8Array;

export const SIGNER_VIEW_PDF_ERRORS = ['not_found', 'session_required', 'rate_limited'] as const;

export interface SignerViewPdfDeps {
  allowedOrigins: string[];
  db: EsignDb;
  storage: Pick<EsignStorage, 'getWorking'>;
  /** Default: 30 per address and 3000 in all per 10 minutes. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

export function createSignerViewPdfHandler(deps: SignerViewPdfDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-signer-view-pdf',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_signer_view_pdf', { max: 30, windowMinutes: 10 }, { max: 3000, windowMinutes: 10 }),
    maxBodyBytes: 8_192,
    logSink: deps.logSink,
    async handle({ body, log, ip, userAgent }) {
      const b = objectBody(body);
      const at = now();
      const { signer, envelope } = await requireSignable(db, b.token, at);
      await requireSessionIfHigh(db, { envelope, signerId: signer.id, sessionToken: b.session_token, ip, now: at });
      if (!envelope.source_pdf_path) {
        log.error('a live envelope has no source document', undefined, { envelope_id: envelope.id });
        throw linkNotFound();
      }

      if (b.consent === true && !signer.consented_at) {
        const version = consentVersionOf(b.consent_version);
        try {
          const recorded = await rows(
            'consent write',
            db
              .from('esign_envelope_signers')
              .update({ consented_at: at.toISOString(), consent_disclosure_version: version })
              .eq('id', signer.id)
              .is('consented_at', null)
              .select('id'),
          );
          if (recorded.length > 0) {
            await recordEvent(db, log, {
              envelope_id: envelope.id,
              signer_id: signer.id,
              event_type: 'consent_accepted',
              ip,
              user_agent: userAgent,
              metadata: { disclosure_version: version },
            });
          }
        } catch (err) {
          // Sign records consent itself when this never landed.
          log.error('consent write failed', err, { signer_id: signer.id });
        }
      }

      const bytes = await deps.storage.getWorking(envelope.source_pdf_path);

      const firstView = signer.first_viewed_at === null;
      const update: Row = {};
      if (firstView) update.first_viewed_at = at.toISOString();
      if (signer.status === 'invited') update.status = 'viewed';
      if (Object.keys(update).length > 0) {
        try {
          await rows(
            'view stamp',
            db.from('esign_envelope_signers').update(update).eq('id', signer.id).in('status', [...SIGNABLE_SIGNER]).select('id'),
          );
        } catch (err) {
          log.error('view stamp failed', err, { signer_id: signer.id });
        }
      }
      if (firstView) {
        await recordEvent(db, log, { envelope_id: envelope.id, signer_id: signer.id, event_type: 'signer_viewed_pdf', ip, user_agent: userAgent });
      }

      return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    },
  });
}
