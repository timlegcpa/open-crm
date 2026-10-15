// esign-signer-request-sms: text a 'high' envelope's signer a six-digit code. Public,
// rate limited per address and in all, and per signer inside (3 an hour, 10 in all).
//
// The code is made here (uniform six digits), and only its HMAC is stored, in a row
// written BEFORE the text goes out: a code that left without a row could never be
// checked, while a row without a text is just unused. A send that fails removes the row
// again. A newer code supersedes older ones (verify-sms checks only the newest). Without
// a text provider in production the send throws OutboundConfigError: 503, said plainly.

import { decryptPiiSplit, fromBytea } from '../_shared/crypto.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import type { OrgIdentity } from '../_shared/organization.ts';
import { OutboundConfigError, type SendResult, type SmsMessage } from '../_shared/outbound.ts';
import { countOf, maybeOne, run, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { smsCodeText } from '../esign-finalize-envelope/lib/emails.ts';
import { linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { isE164 } from '../esign-finalize-envelope/lib/phone.ts';
import { publicLimits, requireSignable, type RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';
import {
  isSmsCodeKey,
  randomSixDigits,
  SMS_CODE_MINUTES,
  SMS_LIFETIME,
  SMS_PER_HOUR,
  smsCodeHash,
} from '../esign-finalize-envelope/lib/sms.ts';

export interface SignerRequestSmsRequest {
  token: string;
}

export interface SignerRequestSmsResponse {
  ok: true;
  last_four: string;
}

export const SIGNER_REQUEST_SMS_ERRORS = ['not_found', 'no_phone', 'too_many_codes', 'code_limit_reached', 'sms_failed', 'sms_unavailable', 'rate_limited'] as const;

export interface SignerRequestSmsDeps {
  allowedOrigins: string[];
  db: EsignDb;
  loadOrg(): Promise<OrgIdentity>;
  sendSms(message: SmsMessage): Promise<SendResult>;
  piiKey: string | null;
  smsCodeKey: string | null;
  /** Default: 10 per address and 100 in all per hour. */
  rateLimit?: RateLimit;
  randomCode?: () => string;
  now?: () => Date;
  logSink?: LogSink;
}

const HOUR_MS = 60 * 60 * 1000;

export function createSignerRequestSmsHandler(deps: SignerRequestSmsDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const randomCode = deps.randomCode ?? (() => randomSixDigits());
  return createHandler({
    name: 'esign-signer-request-sms',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_signer_request_sms', { max: 10, windowMinutes: 60 }, { max: 100, windowMinutes: 60 }),
    maxBodyBytes: 8_192,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const at = now();
      const { signer, envelope } = await requireSignable(db, objectBody(body).token, at);
      if (envelope.verification_level !== 'high') throw linkNotFound();
      if (!deps.piiKey || !isSmsCodeKey(deps.smsCodeKey)) {
        log.error('PII_ENCRYPTION_KEY or ESIGN_SMS_CODE_KEY is not set');
        throw new HttpError(503, 'Text message codes are not set up on this server yet.', 'sms_unavailable');
      }
      const phone = await maybeOne<{ phone_ciphertext: string | null; phone_iv: string | null; phone_last_four: string | null }>(
        'phone read',
        db.from('esign_envelope_signers').select('phone_ciphertext, phone_iv, phone_last_four').eq('id', signer.id).maybeSingle(),
      );
      if (!phone?.phone_ciphertext || !phone.phone_iv || !phone.phone_last_four) {
        log.error('a high envelope signer has no phone', undefined, { signer_id: signer.id });
        throw new HttpError(409, 'No phone number is on file for this signer. Ask the sender to add one.', 'no_phone');
      }

      // Per signer, counted from the code rows themselves.
      const [lastHour, lifetime] = await Promise.all([
        countOf(
          'hourly code count',
          db.from('esign_sms_verifications').select('id', { count: 'exact', head: true }).eq('signer_id', signer.id).gte('created_at', new Date(at.getTime() - HOUR_MS).toISOString()),
        ),
        countOf('lifetime code count', db.from('esign_sms_verifications').select('id', { count: 'exact', head: true }).eq('signer_id', signer.id)),
      ]);
      if (lifetime >= SMS_LIFETIME || lastHour >= SMS_PER_HOUR) {
        const scope = lifetime >= SMS_LIFETIME ? 'sms_request_per_signer_lifetime' : 'sms_request_per_signer_hourly';
        await recordEvent(db, log, {
          envelope_id: envelope.id,
          signer_id: signer.id,
          event_type: 'rate_limit_hit',
          ip,
          user_agent: userAgent,
          metadata: { scope, limit: lifetime >= SMS_LIFETIME ? SMS_LIFETIME : SMS_PER_HOUR },
        });
        if (lifetime >= SMS_LIFETIME) {
          throw new HttpError(429, 'No more codes can be sent for this document. Contact the sender.', 'code_limit_reached');
        }
        throw new HttpError(429, 'Too many codes were requested. Wait an hour and try again.', 'too_many_codes');
      }

      const to = await decryptPiiSplit(fromBytea(phone.phone_ciphertext), fromBytea(phone.phone_iv), deps.piiKey);
      if (!isE164(to)) {
        log.error('a stored phone is not E.164', undefined, { signer_id: signer.id });
        throw new HttpError(409, 'The phone number on file cannot receive codes. Ask the sender to correct it.', 'no_phone');
      }

      const code = randomCode();
      const inserted = await maybeOne<{ id: string }>(
        'code insert',
        db
          .from('esign_sms_verifications')
          .insert({
            signer_id: signer.id,
            code_hash: await smsCodeHash(deps.smsCodeKey, signer.id, code),
            sent_to_last_four: phone.phone_last_four,
            expires_at: new Date(at.getTime() + SMS_CODE_MINUTES * 60_000).toISOString(),
          })
          .select('id')
          .single(),
      );
      if (!inserted) throw new Error('code insert returned no row');

      let result: SendResult;
      try {
        const org = await deps.loadOrg();
        result = await deps.sendSms({ to, body: smsCodeText(org.displayName, code, SMS_CODE_MINUTES) });
      } catch (err) {
        await removeCode(inserted.id);
        if (err instanceof OutboundConfigError) {
          log.error('sms is not configured', err);
          throw new HttpError(503, 'Text message codes are not set up on this server yet.', 'sms_unavailable');
        }
        throw err;
      }
      if (result.status === 'failed') {
        await removeCode(inserted.id);
        throw new HttpError(502, 'The code could not be sent. Try again in a minute.', 'sms_failed');
      }

      await recordEvent(db, log, {
        envelope_id: envelope.id,
        signer_id: signer.id,
        event_type: 'sms_code_sent',
        ip,
        user_agent: userAgent,
        // The last four only: the number itself is encrypted on the signer row.
        metadata: { last_four: phone.phone_last_four },
      });
      return json(200, { ok: true, last_four: phone.phone_last_four } satisfies SignerRequestSmsResponse);

      async function removeCode(id: string) {
        try {
          await run('code remove', db.from('esign_sms_verifications').delete().eq('id', id));
        } catch (err) {
          log.error('unsent code row not removed', err);
        }
      }
    },
  });
}
