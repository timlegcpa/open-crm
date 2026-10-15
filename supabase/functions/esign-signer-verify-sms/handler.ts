// esign-signer-verify-sms: check the six-digit code. Public, rate limited.
//
// One transaction does the check (esign_check_sms_code): only the signer's newest unused
// code can match, each guess is counted under a row lock, and five wrong guesses lock the
// code. A match opens a 30-minute session pinned to this address and answers its token
// (the database keeps only the SHA-256). Without an address there is nothing to pin a
// session to, so the call is refused.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { call, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { publicLimits, requireSignable, type RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';
import {
  isSmsCodeKey,
  SMS_CODE_PATTERN,
  SMS_MAX_ATTEMPTS,
  SMS_SESSION_MINUTES,
  smsCodeHash,
} from '../esign-finalize-envelope/lib/sms.ts';
import { newToken } from '../esign-finalize-envelope/lib/text.ts';

export interface SignerVerifySmsRequest {
  token: string;
  code: string;
}

export type SignerVerifySmsResponse =
  | { ok: true; session_token: string }
  | { ok: false; state: 'invalid' | 'locked' | 'expired' | 'none'; attempts_left: number };

export const SIGNER_VERIFY_SMS_ERRORS = ['invalid_code', 'no_address', 'not_found', 'sms_unavailable', 'rate_limited'] as const;

export interface SignerVerifySmsDeps {
  allowedOrigins: string[];
  db: EsignDb;
  smsCodeKey: string | null;
  /** Default: 20 per address and 500 in all per 10 minutes. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

export function createSignerVerifySmsHandler(deps: SignerVerifySmsDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-signer-verify-sms',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_signer_verify_sms', { max: 20, windowMinutes: 10 }, { max: 500, windowMinutes: 10 }),
    maxBodyBytes: 8_192,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      if (typeof b.code !== 'string' || !SMS_CODE_PATTERN.test(b.code)) throw badRequest('Enter the six-digit code.', 'invalid_code');
      const { signer, envelope } = await requireSignable(db, b.token, now());
      if (envelope.verification_level !== 'high') throw linkNotFound();
      if (!ip) throw new HttpError(400, 'Your network address could not be read. Try another connection.', 'no_address');
      if (!isSmsCodeKey(deps.smsCodeKey)) {
        log.error('ESIGN_SMS_CODE_KEY is not set');
        throw new HttpError(503, 'Text message codes are not set up on this server yet.', 'sms_unavailable');
      }

      const session = await newToken();
      const result = await call<{ status: 'none' | 'expired' | 'locked' | 'invalid' | 'approved'; attempts: number }>(db, 'esign_check_sms_code', {
        p_signer_id: signer.id,
        p_code_hash: await smsCodeHash(deps.smsCodeKey, signer.id, b.code),
        p_max_attempts: SMS_MAX_ATTEMPTS,
        p_session_token_hash: session.hash,
        p_ip: ip,
        p_session_minutes: SMS_SESSION_MINUTES,
      });

      if (result.status === 'approved') {
        await recordEvent(db, log, { envelope_id: envelope.id, signer_id: signer.id, event_type: 'sms_code_verified', ip, user_agent: userAgent });
        return json(200, { ok: true, session_token: session.token } satisfies SignerVerifySmsResponse);
      }
      if (result.status === 'invalid' || result.status === 'locked') {
        await recordEvent(db, log, {
          envelope_id: envelope.id,
          signer_id: signer.id,
          event_type: 'sms_code_failed',
          ip,
          user_agent: userAgent,
          metadata: { attempts: result.attempts },
        });
      }
      const attemptsLeft = result.status === 'invalid' ? Math.max(0, SMS_MAX_ATTEMPTS - result.attempts) : 0;
      return json(200, { ok: false, state: result.status, attempts_left: attemptsLeft } satisfies SignerVerifySmsResponse);
    },
  });
}
