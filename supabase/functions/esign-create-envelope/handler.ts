// esign-create-envelope: a new draft envelope. Owner only.
//
// The title is cleaned (control characters out, trimmed) and must be 1 to 200
// characters. A primary contact, when given, must exist. 'high' verification needs text
// messages to be available (settings and a configured provider, lib/settings.ts), or every
// signer would stall at the code step.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { maybeOne, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, objectBody, smsUnavailable } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { loadEsignSettings, smsAvailable } from '../esign-finalize-envelope/lib/settings.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';

export interface CreateEnvelopeRequest {
  title: string;
  /** 'high' adds an SMS code before signing; anything else is 'standard'. */
  verification_level?: 'standard' | 'high';
  primary_contact_id?: string | null;
}

export interface CreateEnvelopeResponse {
  id: string;
  title: string;
  verification_level: 'standard' | 'high';
  status: 'draft';
  created_at: string;
}

export const CREATE_ENVELOPE_ERRORS = ['bad_request', 'invalid_title', 'contact_not_found', 'sms_unavailable'] as const;

export interface CreateEnvelopeDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  smsEnv: { production: boolean; twilioConfigured: boolean };
  logSink?: LogSink;
}

export function createCreateEnvelopeHandler(deps: CreateEnvelopeDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'esign-create-envelope',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      const title = typeof b.title === 'string' ? stripControl(b.title) : '';
      if (title.length < 1 || title.length > 200) {
        throw badRequest('Give the envelope a title of 1 to 200 characters.', 'invalid_title');
      }
      const level: 'standard' | 'high' = b.verification_level === 'high' ? 'high' : 'standard';
      const primary = b.primary_contact_id ?? null;
      if (primary !== null && !isUuid(primary)) throw badRequest();

      if (primary) {
        const contact = await maybeOne('contact read', deps.db.from('contacts').select('id').eq('id', primary).maybeSingle());
        if (!contact) throw new HttpError(404, 'That contact no longer exists.', 'contact_not_found');
      }
      if (level === 'high' && !smsAvailable(await loadEsignSettings(deps.db), deps.smsEnv)) throw smsUnavailable();

      const row = await maybeOne<CreateEnvelopeResponse>(
        'envelope insert',
        deps.db
          .from('esign_envelopes')
          .insert({ created_by: principal.userId, title, verification_level: level, primary_contact_id: primary, status: 'draft' })
          .select('id, title, verification_level, status, created_at')
          .single(),
      );
      if (!row) throw new Error('envelope insert returned no row');

      await recordEvent(deps.db, log, {
        envelope_id: row.id,
        event_type: 'envelope_created',
        ip,
        user_agent: userAgent,
        metadata: { title, verification_level: level },
      });
      return json(200, row satisfies CreateEnvelopeResponse);
    },
  });
}
