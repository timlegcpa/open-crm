// esign-resolve-token: what the signing page shows for a link. Public, rate limited.
//
// The token is the capability. An unknown token is one 404. A token its holder really
// owns but can no longer use answers 200 with the reason (`state`) and the minimum to
// say it: the title and the signer's own name. A usable one answers the signer's fields
// and the page count. A resolve logs signer_opened_link at most once per signer per
// hour (OPEN_EVENT_GAP_MINUTES), so a link holder cannot grow the event log, and with it
// the executed PDF's audit trail, without bound; the first stamps opened_email_at. The organization's name and logo come
// from get_org_branding() on the page, not from here.

import { createHandler } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { countOf, rows, run, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { linkNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { isLiveEnvelope, isSignableSigner } from '../esign-finalize-envelope/lib/signer-access.ts';
import {
  loadByToken,
  publicLimits,
  signerContact,
  terminalState,
  type RateLimit,
  type TerminalState,
} from '../esign-finalize-envelope/lib/signer-flow.ts';
import { resolveSignerNameParts } from '../esign-finalize-envelope/lib/signer-name.ts';

export interface ResolveTokenRequest {
  token: string;
}

export interface ResolvedField {
  id: string;
  page_index: number;
  field_type: 'signature' | 'date';
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResolveTokenResponse =
  | {
      state: 'ok';
      envelope: { id: string; title: string; verification_level: 'standard' | 'high'; status: string };
      signer: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string;
        status: string;
        signed_at: string | null;
        phone_last_four: string | null;
      };
      document: { page_count: number };
      fields: ResolvedField[];
      needs_sms: boolean;
    }
  | {
      state: TerminalState;
      envelope: { title: string };
      signer: { first_name: string | null; last_name: string | null; email: string };
    };

export const RESOLVE_TOKEN_ERRORS = ['not_found', 'rate_limited'] as const;

/** One signer_opened_link row per signer in this many minutes. */
export const OPEN_EVENT_GAP_MINUTES = 60;

export interface ResolveTokenDeps {
  allowedOrigins: string[];
  db: EsignDb;
  /** Default: 30 per address and 3000 in all per 10 minutes. */
  rateLimit?: RateLimit;
  now?: () => Date;
  logSink?: LogSink;
}

export function createResolveTokenHandler(deps: ResolveTokenDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-resolve-token',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_resolve_token', { max: 30, windowMinutes: 10 }, { max: 3000, windowMinutes: 10 }),
    maxBodyBytes: 4_096,
    logSink: deps.logSink,
    async handle({ body, json, log, ip, userAgent }) {
      const found = await loadByToken(db, objectBody(body).token);
      if (!found) throw linkNotFound();
      const { signer, envelope } = found;
      const at = now();
      const contact = await signerContact(db, signer.contact_id);
      const names = resolveSignerNameParts({ email: signer.email, role: signer.role, contact });

      const terminal = terminalState(signer, envelope, at);
      if (terminal) {
        const response: ResolveTokenResponse = {
          state: terminal,
          envelope: { title: envelope.title },
          signer: { ...names, email: signer.email },
        };
        return json(200, response);
      }
      // A draft envelope or a pending signer has no usable link: nothing to say.
      if (!isSignableSigner(signer.status) || !isLiveEnvelope(envelope.status)) throw linkNotFound();

      const [fields, pageCount] = await Promise.all([
        rows<ResolvedField>(
          'field read',
          db
            .from('esign_envelope_fields')
            .select('id, page_index, field_type, x, y, width, height')
            .eq('signer_id', signer.id)
            .order('page_index')
            .order('id'),
        ),
        countOf(
          'page count',
          db.from('esign_envelope_pages').select('id', { count: 'exact', head: true }).eq('envelope_id', envelope.id).eq('deleted', false),
        ),
      ]);

      if (!signer.opened_email_at) {
        try {
          await run(
            'opened stamp',
            db.from('esign_envelope_signers').update({ opened_email_at: at.toISOString() }).eq('id', signer.id).is('opened_email_at', null),
          );
        } catch (err) {
          log.error('opened stamp failed', err, { signer_id: signer.id });
        }
      }
      try {
        const since = new Date(at.getTime() - OPEN_EVENT_GAP_MINUTES * 60_000).toISOString();
        const recent = await countOf(
          'open event read',
          db
            .from('esign_envelope_events')
            .select('id', { count: 'exact', head: true })
            .eq('signer_id', signer.id)
            .eq('event_type', 'signer_opened_link')
            .gte('created_at', since),
        );
        if (recent === 0) {
          await recordEvent(db, log, { envelope_id: envelope.id, signer_id: signer.id, event_type: 'signer_opened_link', ip, user_agent: userAgent });
        }
      } catch (err) {
        log.error('open event check failed', err, { signer_id: signer.id });
      }

      const response: ResolveTokenResponse = {
        state: 'ok',
        envelope: { id: envelope.id, title: envelope.title, verification_level: envelope.verification_level, status: envelope.status },
        signer: {
          id: signer.id,
          ...names,
          // The signer's own address, never the contact's: on a co-signer link they differ.
          email: signer.email,
          status: signer.status,
          signed_at: signer.signed_at,
          phone_last_four: signer.phone_last_four,
        },
        document: { page_count: pageCount },
        fields: fields.map((f) => ({
          id: f.id,
          page_index: f.page_index,
          field_type: f.field_type,
          x: Number(f.x),
          y: Number(f.y),
          width: Number(f.width),
          height: Number(f.height),
        })),
        needs_sms: envelope.verification_level === 'high',
      };
      return json(200, response);
    },
  });
}
