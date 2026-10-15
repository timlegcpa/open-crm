// esign-void-envelope: cancel a live envelope. Owner only.
//
// The void is CLAIMED with a status guard, so it cannot overwrite an envelope that
// completed a moment earlier. Then every signer still waiting has its link expired, every
// PENDING portal task of a signer who had not signed is dismissed (a signed signer's
// completed task is history and stays), and the signers who had not signed, and the
// owner, are told by email. The emails are best effort: the void is done either way.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { createHandler } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { rows, maybeOne } from '../esign-finalize-envelope/lib/db.ts';
import { voidedEmail } from '../esign-finalize-envelope/lib/emails.ts';
import { badRequest, envelopeNotFound, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { createMailer, type MailDeps } from '../esign-finalize-envelope/lib/mail.ts';
import { LIVE_ENVELOPE } from '../esign-finalize-envelope/lib/signer-access.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';
import { notLive } from '../esign-resend-invite/handler.ts';

export interface VoidEnvelopeRequest {
  envelope_id: string;
  void_reason?: string | null;
}

export interface VoidEnvelopeResponse {
  ok: true;
  signers_voided: number;
  tasks_dismissed: number;
}

export const VOID_ENVELOPE_ERRORS = ['bad_request', 'invalid_reason', 'not_live', 'not_found'] as const;

const VOID_REASON_MAX = 500;
const WAITING = ['pending', 'invited', 'viewed'];

export interface VoidEnvelopeDeps extends MailDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  ownerEmail(): Promise<string | null>;
  now?: () => Date;
  logSink?: LogSink;
}

export function createVoidEnvelopeHandler(deps: VoidEnvelopeDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-void-envelope',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    maxBodyBytes: 16_384,
    logSink: deps.logSink,
    async handle({ principal, body, json, log, ip, userAgent }) {
      const b = objectBody(body);
      if (!isUuid(b.envelope_id)) throw badRequest();
      let reason: string | null = null;
      if (b.void_reason !== undefined && b.void_reason !== null) {
        if (typeof b.void_reason !== 'string') throw badRequest('The reason must be text of up to 500 characters.', 'invalid_reason');
        const cleaned = stripControl(b.void_reason);
        if (cleaned.length > VOID_REASON_MAX) throw badRequest('The reason must be text of up to 500 characters.', 'invalid_reason');
        reason = cleaned || null;
      }

      const envelope = await maybeOne<{ id: string; title: string; status: string }>(
        'envelope read',
        db.from('esign_envelopes').select('id, title, status').eq('id', b.envelope_id).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (!(LIVE_ENVELOPE as readonly string[]).includes(envelope.status)) throw notLive();

      const signers = await rows<{ id: string; status: string; email: string; role: string; contact_id: string | null; client_task_id: string | null }>(
        'signer read',
        db.from('esign_envelope_signers').select('id, status, email, role, contact_id, client_task_id').eq('envelope_id', envelope.id),
      );
      const unsigned = signers.filter((s) => s.status !== 'signed');
      const at = now().toISOString();

      const voided = await rows(
        'envelope void claim',
        db
          .from('esign_envelopes')
          .update({ status: 'voided', voided_at: at, void_reason: reason })
          .eq('id', envelope.id)
          .in('status', [...LIVE_ENVELOPE])
          .select('id'),
      );
      if (voided.length === 0) throw notLive();

      const expired = await db
        .from('esign_envelope_signers')
        .update({ status: 'expired', token_expires_at: at })
        .eq('envelope_id', envelope.id)
        .in('status', WAITING);
      if (expired.error) throw expired.error;

      let tasksDismissed = 0;
      const taskIds = unsigned.map((s) => s.client_task_id).filter((id): id is string => !!id);
      if (taskIds.length > 0) {
        const dismissed = await rows(
          'task dismiss',
          db.from('client_tasks').update({ status: 'dismissed' }).in('id', taskIds).eq('status', 'pending').select('id'),
        );
        tasksDismissed = dismissed.length;
      }

      await recordEvent(db, log, {
        envelope_id: envelope.id,
        event_type: 'envelope_voided',
        ip,
        user_agent: userAgent,
        metadata: { admin_user_id: principal.userId, void_reason: reason, signers_voided: unsigned.length },
      });

      try {
        const mailer = await createMailer(deps, log);
        const contactIds = [...new Set(unsigned.map((s) => s.contact_id).filter((id): id is string => !!id))];
        const contacts = contactIds.length
          ? await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', contactIds))
          : [];
        const byId = new Map(contacts.map((c) => [c.id, c]));
        const recipients = unsigned.map((s) => {
          const contact = s.contact_id ? byId.get(s.contact_id) ?? null : null;
          const name = contact ? resolveSignerName({ email: s.email, role: s.role, contact }) : null;
          return { email: s.email, name: name === s.email ? null : name };
        });
        const owner = await deps.ownerEmail();
        if (owner) recipients.push({ email: owner, name: null });
        for (const r of recipients) {
          await mailer.send(r.email, voidedEmail({ org: mailer.org, recipientName: r.name, title: envelope.title }), {
            tags: { envelope_id: envelope.id, kind: 'esign_voided' },
            idempotencyKey: `esign-voided:${envelope.id}:${await sha256Hex(r.email)}`,
          });
        }
      } catch (err) {
        log.error('void notices not sent', err, { envelope_id: envelope.id });
      }

      return json(200, { ok: true, signers_voided: unsigned.length, tasks_dismissed: tasksDismissed } satisfies VoidEnvelopeResponse);
    },
  });
}
