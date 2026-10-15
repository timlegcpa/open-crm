// esign-resend-invite: a fresh link for one signer of a live envelope. Owner only.
//
// The old link stops working (only the new token's hash is stored). The link lives 14
// days from now, never less than it had, and the envelope's own deadline moves out to
// match (the expiry run reads the envelope's deadline, so a link resent on day 13 would
// otherwise die the next morning). A signer still pending because its first link was
// never written is recovered here: it becomes invited.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { maybeOne, run, type Row } from '../esign-finalize-envelope/lib/db.ts';
import { inviteEmail } from '../esign-finalize-envelope/lib/emails.ts';
import { badRequest, envelopeNotFound, objectBody, signerNotFound } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { createMailer, type MailDeps } from '../esign-finalize-envelope/lib/mail.ts';
import { LIVE_ENVELOPE } from '../esign-finalize-envelope/lib/signer-access.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';
import { DAY_MS, newToken, SIGNING_LINK_DAYS, signingUrl } from '../esign-finalize-envelope/lib/text.ts';

export interface ResendInviteRequest {
  envelope_id: string;
  signer_id: string;
}

export interface ResendInviteResponse {
  ok: true;
}

export const RESEND_INVITE_ERRORS = ['bad_request', 'not_live', 'not_resendable', 'email_failed', 'site_url_missing', 'not_found', 'signer_not_found'] as const;

export interface ResendInviteDeps extends MailDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  siteUrl: string | null;
  now?: () => Date;
  logSink?: LogSink;
}

export const notLive = () => new HttpError(409, 'This envelope is not waiting for signatures.', 'not_live');

export function createResendInviteHandler(deps: ResendInviteDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-resend-invite',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ principal, body, json, log }) {
      const b = objectBody(body);
      if (!isUuid(b.envelope_id) || !isUuid(b.signer_id)) throw badRequest();
      if (!deps.siteUrl) {
        log.error('SITE_URL is not set; a signing link cannot be built');
        throw new HttpError(500, 'Signing links are not set up on this server yet (SITE_URL).', 'site_url_missing');
      }

      const envelope = await maybeOne<{ id: string; title: string; status: string; verification_level: string; expires_at: string | null }>(
        'envelope read',
        db.from('esign_envelopes').select('id, title, status, verification_level, expires_at').eq('id', b.envelope_id).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (!(LIVE_ENVELOPE as readonly string[]).includes(envelope.status)) throw notLive();

      const signer = await maybeOne<{ id: string; contact_id: string | null; email: string; role: string; status: string; token_expires_at: string | null }>(
        'signer read',
        db
          .from('esign_envelope_signers')
          .select('id, contact_id, email, role, status, token_expires_at')
          .eq('id', b.signer_id)
          .eq('envelope_id', b.envelope_id)
          .maybeSingle(),
      );
      if (!signer) throw signerNotFound();
      if (!['pending', 'invited', 'viewed'].includes(signer.status)) {
        throw new HttpError(409, 'This signer has already finished and cannot be sent a new link.', 'not_resendable');
      }

      const mailer = await createMailer(deps, log);
      const { token, hash } = await newToken();
      const at = now();
      const expiresMs = Math.max(signer.token_expires_at ? Date.parse(signer.token_expires_at) : 0, at.getTime() + SIGNING_LINK_DAYS * DAY_MS);
      const expiresAt = new Date(expiresMs).toISOString();
      if (expiresMs > (envelope.expires_at ? Date.parse(envelope.expires_at) : 0)) {
        await run(
          'envelope deadline extend',
          db.from('esign_envelopes').update({ expires_at: expiresAt }).eq('id', envelope.id).in('status', [...LIVE_ENVELOPE]),
        );
      }
      const update: Row = { token_hash: hash, token_expires_at: expiresAt };
      if (signer.status === 'pending') Object.assign(update, { status: 'invited', invited_at: at.toISOString() });
      await run('signer token write', db.from('esign_envelope_signers').update(update).eq('id', signer.id));

      let contact: SignerContact | null = null;
      if (signer.contact_id) {
        contact = await maybeOne<SignerContact>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).eq('id', signer.contact_id).maybeSingle());
      }
      const name = contact ? resolveSignerName({ email: signer.email, role: signer.role, contact }) : null;
      const status = await mailer.send(
        signer.email,
        inviteEmail({
          org: mailer.org,
          recipientName: name === signer.email ? null : name,
          title: envelope.title,
          url: signingUrl(deps.siteUrl, token),
          high: envelope.verification_level === 'high',
        }),
        { tags: { esign_signer_id: signer.id, kind: 'esign_invite' }, idempotencyKey: `esign-invite:${signer.id}:${hash.slice(0, 16)}` },
      );
      if (status !== 'sent') {
        // The new link is already in place; another resend tries again.
        throw new HttpError(502, 'The invitation email could not be sent. Try again.', 'email_failed');
      }
      await recordEvent(db, log, {
        envelope_id: envelope.id,
        signer_id: signer.id,
        event_type: 'invite_resent',
        metadata: { admin_user_id: principal.userId, email: signer.email },
      });
      return json(200, { ok: true } satisfies ResendInviteResponse);
    },
  });
}
