// esign-signer-decline: a signer declines to sign. Public, rate limited.
//
// The signer's row is CLAIMED declined with a status guard (a signer who signed a moment
// earlier cannot then decline), and the envelope becomes declined: one refusal ends it.
// Every other signer still waiting has its link expired, every pending portal task of a
// signer who had not signed is dismissed, and the owner is told by email. A repeat
// answers { ok, already_declined } and re-drives the envelope status, so a decline whose
// envelope write failed is finished by the retry.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { maybeOne, rows, run } from '../esign-finalize-envelope/lib/db.ts';
import { declinedAlertEmail } from '../esign-finalize-envelope/lib/emails.ts';
import { badRequest, linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { createMailer, type MailDeps } from '../esign-finalize-envelope/lib/mail.ts';
import { LIVE_ENVELOPE, SIGNABLE_SIGNER } from '../esign-finalize-envelope/lib/signer-access.ts';
import {
  isSignableNow,
  loadByToken,
  publicLimits,
  requireSessionIfHigh,
  signerContact,
  type RateLimit,
} from '../esign-finalize-envelope/lib/signer-flow.ts';
import { resolveSignerName } from '../esign-finalize-envelope/lib/signer-name.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';

export interface SignerDeclineRequest {
  token: string;
  reason?: string | null;
  session_token?: string;
}

export type SignerDeclineResponse = { ok: true } | { ok: true; already_declined: true };

export const SIGNER_DECLINE_ERRORS = ['invalid_reason', 'already_signed', 'not_found', 'session_required', 'not_signable', 'rate_limited'] as const;

const REASON_MAX = 500;

export interface SignerDeclineDeps extends MailDeps {
  allowedOrigins: string[];
  ownerEmail(): Promise<string | null>;
  siteUrl: string | null;
  /** Default: 30 per address and 300 in all per 10 minutes. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

export function createSignerDeclineHandler(deps: SignerDeclineDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-signer-decline',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_signer_decline', { max: 30, windowMinutes: 10 }, { max: 300, windowMinutes: 10 }),
    maxBodyBytes: 8_192,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      let reason: string | null = null;
      if (b.reason !== undefined && b.reason !== null) {
        if (typeof b.reason !== 'string') throw badRequest('The reason must be text of up to 500 characters.', 'invalid_reason');
        const cleaned = stripControl(b.reason);
        if (cleaned.length > REASON_MAX) throw badRequest('The reason must be text of up to 500 characters.', 'invalid_reason');
        reason = cleaned || null;
      }

      const found = await loadByToken(db, b.token);
      if (!found) throw linkNotFound();
      const { signer, envelope } = found;
      if (signer.status === 'declined') {
        await redriveDeclined(envelope.id);
        return json(200, { ok: true, already_declined: true } satisfies SignerDeclineResponse);
      }
      if (signer.status === 'signed') throw new HttpError(409, 'This document has already been signed.', 'already_signed');
      const at = now();
      if (!isSignableNow(signer, envelope, at)) throw linkNotFound();
      await requireSessionIfHigh(db, { envelope, signerId: signer.id, sessionToken: b.session_token, ip, now: at });

      const atIso = at.toISOString();
      const claimed = await rows(
        'decline claim',
        db
          .from('esign_envelope_signers')
          .update({ status: 'declined', token_expires_at: atIso })
          .eq('id', signer.id)
          .in('status', [...SIGNABLE_SIGNER])
          .select('id'),
      );
      if (claimed.length === 0) {
        const current = await maybeOne<{ status: string }>(
          'signer reread',
          db.from('esign_envelope_signers').select('status').eq('id', signer.id).maybeSingle(),
        );
        if (current?.status === 'declined') {
          await redriveDeclined(envelope.id);
          return json(200, { ok: true, already_declined: true } satisfies SignerDeclineResponse);
        }
        throw new HttpError(409, 'This document is no longer available to sign.', 'not_signable');
      }
      await redriveDeclined(envelope.id);

      const siblings = await db
        .from('esign_envelope_signers')
        .update({ status: 'expired', token_expires_at: atIso })
        .eq('envelope_id', envelope.id)
        .neq('id', signer.id)
        .in('status', ['pending', 'invited', 'viewed']);
      if (siblings.error) log.error('sibling expiry failed', siblings.error, { envelope_id: envelope.id });

      await recordEvent(db, log, {
        envelope_id: envelope.id,
        signer_id: signer.id,
        event_type: 'signer_declined',
        ip,
        user_agent: userAgent,
        metadata: { reason },
      });

      try {
        const unsigned = await rows<{ client_task_id: string | null }>(
          'task read',
          db.from('esign_envelope_signers').select('client_task_id').eq('envelope_id', envelope.id).neq('status', 'signed').not('client_task_id', 'is', null),
        );
        const taskIds = unsigned.map((r) => r.client_task_id).filter((id): id is string => !!id);
        if (taskIds.length > 0) {
          await run('task dismiss', db.from('client_tasks').update({ status: 'dismissed' }).in('id', taskIds).eq('status', 'pending'));
        }
      } catch (err) {
        log.error('task dismiss failed', err, { envelope_id: envelope.id });
      }

      try {
        const owner = await deps.ownerEmail();
        if (owner) {
          const mailer = await createMailer(deps, log);
          const contact = await signerContact(db, signer.contact_id);
          await mailer.send(
            owner,
            declinedAlertEmail({
              org: mailer.org,
              title: envelope.title,
              signerName: resolveSignerName({ email: signer.email, role: signer.role, contact }),
              signerEmail: signer.email,
              reason,
              esignUrl: `${(deps.siteUrl ?? '').replace(/\/+$/, '')}/esign`,
            }),
            { tags: { envelope_id: envelope.id, kind: 'esign_declined' }, idempotencyKey: `esign-declined:${signer.id}` },
          );
        }
      } catch (err) {
        log.error('decline alert not sent', err, { envelope_id: envelope.id });
      }

      return json(200, { ok: true } satisfies SignerDeclineResponse);
    },
  });

  async function redriveDeclined(envelopeId: string): Promise<void> {
    await run(
      'envelope decline',
      db.from('esign_envelopes').update({ status: 'declined' }).eq('id', envelopeId).in('status', [...LIVE_ENVELOPE]),
    );
  }
}
