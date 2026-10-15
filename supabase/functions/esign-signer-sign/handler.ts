// esign-signer-sign: a signer signs. Public, rate limited.
//
// Consent is required in the request. Then the token, then the signature itself:
//   typed  the name in one of the six signature fonts, letters the fonts all draw
//          (TYPED_SIGNATURE_PATTERN), so finalize can never meet a glyph it lacks;
//   drawn  a PNG validated structurally AND trial-embedded with the same pdf-lib
//          finalize stamps it with: an image that passes here always stamps there.
// The claim is one RPC (esign_claim_signer_signature): it locks the envelope, so a void,
// decline or expiry racing this either lands first and the claim refuses, or waits. A
// signer who already signed gets { ok, already_signed } back, so a double click is
// harmless. After the claim: the portal task completes, the signing is logged on the
// contact's activity, and when no signer is outstanding finalize is called (60 s);
// otherwise the envelope becomes partially signed.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { call, countOf, maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import type { PdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import type { FinalizeTrigger } from '../esign-finalize-envelope/lib/signer-access.ts';
import { loadByToken, publicLimits, requireSessionIfHigh, isSignableNow, type RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';
import { validateSignatureImageBase64 } from '../esign-finalize-envelope/lib/signature-image.ts';
import { consentVersionOf } from '../esign-finalize-envelope/lib/text.ts';
import { isSignerFontKey, normalizeTypedSignature } from '../esign-finalize-envelope/lib/typed-signature.ts';

export interface SignerSignRequest {
  token: string;
  consent: true;
  consent_version?: string;
  /** Default 'typed'. */
  kind?: 'typed' | 'drawn';
  /** typed only. */
  signature_text?: string;
  font_key?: string;
  /** drawn only: base64 PNG. */
  signature_image?: string;
  /** IANA zone, e.g. America/New_York: the date field is stamped in it. */
  timezone: string;
  session_token?: string;
}

export type SignerSignResponse = { ok: true; finalized: boolean } | { ok: true; already_signed: true; finalized: false };

export const SIGNER_SIGN_ERRORS = [
  'consent_required',
  'invalid_signature',
  'invalid_font',
  'invalid_timezone',
  'not_found',
  'session_required',
  'not_signable',
  'rate_limited',
] as const;

const TIMEZONE = /^[A-Za-z0-9_/+-]{1,60}$/;

export interface SignerSignDeps {
  allowedOrigins: string[];
  db: EsignDb;
  pdf: Pick<PdfTools, 'trialEmbedPng'>;
  finalize: FinalizeTrigger;
  /** Default: 30 per address and 3000 in all per 10 minutes. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

const invalidSignature = () => badRequest('That signature could not be used. Try again.', 'invalid_signature');

export function createSignerSignHandler(deps: SignerSignDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-signer-sign',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_signer_sign', { max: 30, windowMinutes: 10 }, { max: 3000, windowMinutes: 10 }),
    // A drawn signature is up to 320,000 base64 characters.
    maxBodyBytes: 400_000,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      if (b.consent !== true) throw badRequest('Agree to sign electronically before signing.', 'consent_required');
      const found = await loadByToken(db, b.token);
      if (!found) throw linkNotFound();
      const { signer, envelope } = found;

      if (b.kind !== undefined && b.kind !== 'typed' && b.kind !== 'drawn') throw invalidSignature();
      const kind = b.kind === 'drawn' ? 'drawn' : 'typed';
      let text: string | null = null;
      let fontKey: string | null = null;
      let image: string | null = null;
      if (kind === 'typed') {
        if (b.signature_image !== undefined) throw invalidSignature();
        text = normalizeTypedSignature(b.signature_text);
        if (!text) throw invalidSignature();
        if (!isSignerFontKey(b.font_key)) throw badRequest('Choose one of the signature styles offered.', 'invalid_font');
        fontKey = b.font_key;
      } else {
        if (b.signature_text !== undefined || b.font_key !== undefined) throw invalidSignature();
        const structural = await validateSignatureImageBase64(b.signature_image);
        if (!structural.ok) {
          log.warn('drawn signature refused', { reason: structural.reason });
          throw invalidSignature();
        }
        image = b.signature_image as string;
        if (!(await deps.pdf.trialEmbedPng(image))) {
          log.warn('drawn signature refused', { reason: 'embed' });
          throw invalidSignature();
        }
      }
      if (typeof b.timezone !== 'string' || !TIMEZONE.test(b.timezone)) {
        throw badRequest('The time zone was not recognised. Reload the page and try again.', 'invalid_timezone');
      }
      const timezone = b.timezone;
      const consentVersion = consentVersionOf(b.consent_version);

      if (signer.status === 'signed') return json(200, { ok: true, already_signed: true, finalized: false } satisfies SignerSignResponse);
      const at = now();
      if (!isSignableNow(signer, envelope, at)) throw linkNotFound();
      const method = await requireSessionIfHigh(db, { envelope, signerId: signer.id, sessionToken: b.session_token, ip, now: at });

      const signedAt = at.toISOString();
      const claimed = await call<boolean>(db, 'esign_claim_signer_signature', {
        p_signer_id: signer.id,
        p_kind: kind,
        p_signature_text: text,
        p_font_key: fontKey,
        p_image_base64: image,
        p_signed_at: signedAt,
        p_signed_ip: ip,
        p_signed_user_agent: userAgent ? userAgent.slice(0, 512) : null,
        p_signed_verification_method: method,
        p_signed_timezone: timezone,
        p_consent_version: consentVersion,
      });
      if (claimed !== true) {
        const current = await maybeOne<{ status: string }>(
          'signer reread',
          db.from('esign_envelope_signers').select('status').eq('id', signer.id).maybeSingle(),
        );
        if (current?.status === 'signed') return json(200, { ok: true, already_signed: true, finalized: false } satisfies SignerSignResponse);
        throw new HttpError(409, 'This document is no longer available to sign.', 'not_signable');
      }

      if (signer.client_task_id) {
        try {
          await rows(
            'task complete',
            db.from('client_tasks').update({ status: 'completed', completed_at: signedAt }).eq('id', signer.client_task_id).eq('status', 'pending').select('id'),
          );
        } catch (err) {
          log.error('task complete failed', err, { signer_id: signer.id });
        }
      }
      await recordEvent(db, log, {
        envelope_id: envelope.id,
        signer_id: signer.id,
        event_type: 'signer_signed',
        ip,
        user_agent: userAgent,
        metadata: { signature_kind: kind, font_key: fontKey, timezone, consent: true, consent_version: consentVersion },
      });
      if (signer.contact_id) {
        const activity = await db.from('client_activity_log').insert({
          contact_id: signer.contact_id,
          user_id: null,
          action: 'esign_signed',
          details: { envelope_id: envelope.id, envelope_title: envelope.title, signer_id: signer.id, verification_method: method },
          ip_address: ip,
          user_agent: userAgent ? userAgent.slice(0, 512) : null,
        });
        if (activity.error) log.error('activity insert failed', activity.error, { signer_id: signer.id });
      }

      let outstanding: number;
      try {
        outstanding = await countOf(
          'outstanding count',
          db.from('esign_envelope_signers').select('id', { count: 'exact', head: true }).eq('envelope_id', envelope.id).neq('status', 'signed'),
        );
      } catch (err) {
        // Signed either way; the daily expiry run re-drives an envelope everyone signed.
        log.error('outstanding count failed', err, { envelope_id: envelope.id });
        return json(200, { ok: true, finalized: false } satisfies SignerSignResponse);
      }

      let finalized = false;
      if (outstanding === 0) {
        finalized = await deps.finalize(envelope.id);
      } else {
        const moved = await db.from('esign_envelopes').update({ status: 'partially_signed' }).eq('id', envelope.id).eq('status', 'sent');
        if (moved.error) log.error('partial status failed', moved.error, { envelope_id: envelope.id });
      }
      return json(200, { ok: true, finalized } satisfies SignerSignResponse);
    },
  });
}
