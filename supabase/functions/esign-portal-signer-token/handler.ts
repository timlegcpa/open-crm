// esign-portal-signer-token: a signed-in portal client trades its "Signature needed" task
// for a signing link token. Client only; refused in the owner's View-as-client session
// (the rotation below would kill the link in the client's email).
//
// The portal task carries the signer id and no token. The gate is the addressee: the
// caller's login email must be the address the envelope was sent to, so a second person
// on a record who logs in with their own address reaches only their own signer row. A
// usable signer gets a fresh token (the emailed link stops working: one live link per
// signer); a finished one gets the same terminal state resolve-token names.

import type { AuthOutcome, ClientPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { checkUserLimit, type RateLimitOutcome } from '../_shared/rate-limit.ts';
import { maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { envelopeById, isLiveEnvelope, isSignableSigner, SIGNABLE_SIGNER } from '../esign-finalize-envelope/lib/signer-access.ts';
import { terminalState, type SignableEnvelope, type SignableSigner, type TerminalState } from '../esign-finalize-envelope/lib/signer-flow.ts';
import { newToken } from '../esign-finalize-envelope/lib/text.ts';

export interface PortalSignerTokenRequest {
  signer_id: string;
}

export type PortalSignerTokenResponse = { state: 'ok'; token: string } | { state: TerminalState; envelope: { title: string } };

export const PORTAL_SIGNER_TOKEN_ERRORS = ['not_found', 'wrong_addressee', 'rate_limited', 'impersonation_read_only'] as const;

export interface PortalSignerTokenDeps {
  allowedOrigins: string[];
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  db: EsignDb;
  /** The caller's login email (the client principal carries none). */
  userEmail(userId: string): Promise<string | null>;
  /** Default: 30 per user per 10 minutes (this mints a credential). */
  rateLimit?: (principal: ClientPrincipal) => Promise<RateLimitOutcome>;
  now?: () => Date;
  logSink?: LogSink;
}

export function createPortalSignerTokenHandler(deps: PortalSignerTokenDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const limit =
    deps.rateLimit ??
    ((p: ClientPrincipal) => checkUserLimit(db, { action: 'esign_portal_signer_token', userId: p.userId, max: 30, windowMinutes: 10 }));
  return createHandler({
    name: 'esign-portal-signer-token',
    allowedOrigins: deps.allowedOrigins,
    auth: { client: deps.authorizeClient },
    clientWrites: true,
    rateLimit: ({ principal }) => limit(principal),
    maxBodyBytes: 4_096,
    logSink: deps.logSink,
    async handle({ principal, body, json }) {
      const signerId = objectBody(body).signer_id;
      if (!isUuid(signerId)) throw linkNotFound();

      const signer = await maybeOne<SignableSigner>(
        'signer read',
        db
          .from('esign_envelope_signers')
          .select('id, envelope_id, contact_id, email, role, status, token_expires_at, client_task_id, first_viewed_at, consented_at, phone_last_four, signed_at, opened_email_at')
          .eq('id', signerId)
          .maybeSingle(),
      );
      if (!signer) throw linkNotFound();

      const loginEmail = await deps.userEmail(principal.userId);
      if (!loginEmail || loginEmail.trim().toLowerCase() !== signer.email) {
        throw new HttpError(403, 'This signature request was sent to a different email address.', 'wrong_addressee');
      }

      const envelope = await envelopeById<SignableEnvelope>(db, signer.envelope_id, 'id, title, status, verification_level, source_pdf_path');
      if (!envelope) throw linkNotFound();

      const terminal = terminalState(signer, envelope, now());
      if (terminal) return json(200, { state: terminal, envelope: { title: envelope.title } } satisfies PortalSignerTokenResponse);
      if (!isSignableSigner(signer.status) || !isLiveEnvelope(envelope.status)) throw linkNotFound();

      const { token, hash } = await newToken();
      const rotated = await rows(
        'token rotate',
        db.from('esign_envelope_signers').update({ token_hash: hash }).eq('id', signer.id).in('status', [...SIGNABLE_SIGNER]).select('id'),
      );
      // A sign or void landed between the read and this write.
      if (rotated.length === 0) throw linkNotFound();
      return json(200, { state: 'ok', token } satisfies PortalSignerTokenResponse);
    },
  });
}
