// esign-expire-envelopes: the daily e-signature sweep. The job runner calls it with the
// cron secret (schedule `esign:expire_envelopes`); the owner may run it by hand.
//
//   1. Live envelopes past their deadline, each decided in ONE locked transaction
//      (esign_expire_envelope, under the envelope row lock a signature also takes): one
//      everyone signed is NOT expired, and finalize is re-driven for it (one per run, so
//      the run stays inside the runner's timeout; the rest wait for the next run, still
//      live). Otherwise the waiting signers expire and the envelope flips to expired
//      together; their pending portal tasks are dismissed after.
//   1b. Completed envelopes whose deliverables (filing, the completion event, each
//      party's email) did not all go out: finalize re-drives the delivery alone, a few
//      per run, until it is done or has been tried MAX_DELIVERY_ATTEMPTS times.
//   2. Retention: 90 days after an envelope ended (each status aged by its own moment),
//      its working files go (after a COMPLETE listing), then its drawn images, then the
//      source path is cleared, which takes it out of every later sweep. The executed
//      copy in the documents store is never touched.
//   3. Drawn images of any terminal envelope past the same age, oldest first, and the
//      operational rows (old SMS codes and sessions).
//   4. A summary to the owner when anything expired.
// The answer is counts only, so a rerun is safe and says what it did.

import { sha256Hex } from '../_shared/crypto.ts';
import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler } from '../_shared/handler.ts';
import type { Logger, LogSink } from '../_shared/log.ts';
import { call, rows, run } from '../esign-finalize-envelope/lib/db.ts';
import { expirySummaryEmail } from '../esign-finalize-envelope/lib/emails.ts';
import { recordEvent } from '../esign-finalize-envelope/lib/events.ts';
import { createMailer, type MailDeps } from '../esign-finalize-envelope/lib/mail.ts';
import { LIVE_ENVELOPE, type FinalizeTrigger } from '../esign-finalize-envelope/lib/signer-access.ts';
import { walkWorking, type EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';
import { DAY_MS } from '../esign-finalize-envelope/lib/text.ts';

export type ExpireEnvelopesRequest = Record<string, never> | undefined;

export interface ExpireEnvelopesResponse {
  ok: true;
  expired: number;
  signers_expired: number;
  tasks_dismissed: number;
  finalize_redriven: number;
  finalize_deferred: number;
  delivery_redriven: number;
  working_envelopes_purged: number;
  working_objects_removed: number;
  signature_images_purged: number;
  sms_codes_deleted: number;
  sessions_deleted: number;
}

export const WORKING_RETENTION_DAYS = 90;
const MAX_EXPIRE_PER_RUN = 200;
const MAX_PURGE_PER_RUN = 50;
const MAX_FINALIZE_PER_RUN = 1;
const MAX_DELIVERY_PER_RUN = 3;
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A completed envelope younger than this is still in its own finalize call. */
const DELIVERY_GRACE_MINUTES = 15;

/** Each terminal status, aged by its own moment. */
const TERMINAL_AGE: ReadonlyArray<{ status: string; column: string }> = [
  { status: 'completed', column: 'completed_at' },
  { status: 'voided', column: 'voided_at' },
  { status: 'expired', column: 'expires_at' },
  // No dedicated column: its last write is the decline.
  { status: 'declined', column: 'updated_at' },
];

export interface ExpireEnvelopesDeps extends MailDeps {
  allowedOrigins: string[];
  cronSecret: string | null;
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  storage: EsignStorage;
  finalize: FinalizeTrigger;
  ownerEmail(): Promise<string | null>;
  siteUrl: string | null;
  now?: () => Date;
  logSink?: LogSink;
}

export function createExpireEnvelopesHandler(deps: ExpireEnvelopesDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  return createHandler({
    name: 'esign-expire-envelopes',
    allowedOrigins: deps.allowedOrigins,
    auth: { cron: { secret: deps.cronSecret }, owner: deps.authorizeOwner },
    body: 'optional_json',
    maxBodyBytes: 4_096,
    logSink: deps.logSink,
    async handle({ json, log }) {
      const at = now();
      const atIso = at.toISOString();
      const out: ExpireEnvelopesResponse = {
        ok: true,
        expired: 0,
        signers_expired: 0,
        tasks_dismissed: 0,
        finalize_redriven: 0,
        finalize_deferred: 0,
        delivery_redriven: 0,
        working_envelopes_purged: 0,
        working_objects_removed: 0,
        signature_images_purged: 0,
        sms_codes_deleted: 0,
        sessions_deleted: 0,
      };

      // 1. Past the deadline.
      const due = await rows<{ id: string; title: string }>(
        'due read',
        db.from('esign_envelopes').select('id, title').in('status', [...LIVE_ENVELOPE]).lt('expires_at', atIso).order('expires_at').limit(MAX_EXPIRE_PER_RUN),
      );
      const summary: Array<{ title: string; signersExpired: number }> = [];
      const summaryIds: string[] = [];
      for (const env of due) {
        try {
          const decided = await call<{ status: 'not_due' | 'all_signed' | 'expired'; signers_expired: number; task_ids: string[] }>(
            db,
            'esign_expire_envelope',
            { p_envelope_id: env.id, p_at: atIso },
          );
          if (decided.status === 'all_signed') {
            if (out.finalize_redriven < MAX_FINALIZE_PER_RUN) {
              out.finalize_redriven += 1;
              if (!(await deps.finalize(env.id))) log.warn('finalize re-drive did not complete', { envelope_id: env.id });
            } else {
              out.finalize_deferred += 1;
            }
            continue;
          }
          if (decided.status !== 'expired') continue;
          const result = { signers: decided.signers_expired, tasks: await dismissTasks(decided.task_ids) };
          out.expired += 1;
          out.signers_expired += result.signers;
          out.tasks_dismissed += result.tasks;
          summary.push({ title: env.title, signersExpired: result.signers });
          summaryIds.push(env.id);
          await recordEvent(db, log, {
            envelope_id: env.id,
            event_type: 'envelope_expired',
            metadata: { signers_expired: result.signers, tasks_dismissed: result.tasks },
          });
        } catch (err) {
          log.error('envelope not expired; the next run retries', err, { envelope_id: env.id });
        }
      }

      // 1b. Completed envelopes whose delivery is unfinished.
      try {
        const undelivered = await rows<{ id: string }>(
          'undelivered read',
          db
            .from('esign_envelopes')
            .select('id')
            .eq('status', 'completed')
            .is('delivered_at', null)
            .lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
            .lt('completed_at', new Date(at.getTime() - DELIVERY_GRACE_MINUTES * 60_000).toISOString())
            .order('completed_at')
            .limit(MAX_DELIVERY_PER_RUN),
        );
        for (const env of undelivered) {
          out.delivery_redriven += 1;
          if (!(await deps.finalize(env.id))) log.warn('delivery re-drive did not complete', { envelope_id: env.id });
        }
      } catch (err) {
        log.error('delivery re-drive failed; the next run retries', err);
      }

      // 2. Working files of envelopes that ended long ago.
      const cutoffIso = new Date(at.getTime() - WORKING_RETENTION_DAYS * DAY_MS).toISOString();
      const aged: string[] = [];
      for (const { status, column } of TERMINAL_AGE) {
        if (aged.length >= MAX_PURGE_PER_RUN) break;
        try {
          const found = await rows<{ id: string }>(
            'aged read',
            db
              .from('esign_envelopes')
              .select('id')
              .eq('status', status)
              .lt(column, cutoffIso)
              .not('source_pdf_path', 'is', null)
              .order('id')
              .limit(MAX_PURGE_PER_RUN - aged.length),
          );
          aged.push(...found.map((r) => r.id));
        } catch (err) {
          log.error('aged read failed', err, { status });
        }
      }
      for (const id of aged) {
        try {
          const removed = await purgeWorking(id);
          out.working_envelopes_purged += 1;
          out.working_objects_removed += removed;
        } catch (err) {
          log.error('working purge failed; the next run retries', err, { envelope_id: id });
        }
      }

      // 3. Drawn images and operational rows.
      try {
        out.signature_images_purged = await call<number>(db, 'esign_purge_terminal_signature_images', { p_cutoff: cutoffIso, p_limit: MAX_PURGE_PER_RUN });
      } catch (err) {
        log.error('signature image purge failed', err);
      }
      try {
        const pruned = await call<{ sms_codes_deleted: number; sessions_deleted: number }>(db, 'esign_prune_operational', {});
        out.sms_codes_deleted = pruned.sms_codes_deleted;
        out.sessions_deleted = pruned.sessions_deleted;
      } catch (err) {
        log.error('operational prune failed', err);
      }

      // 4. The owner hears about what expired.
      if (summary.length > 0) await sendSummary(log, summary, summaryIds, atIso);
      return json(200, out);
    },
  });

  /** The expired signers' pending portal tasks, dismissed after the flip. */
  async function dismissTasks(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    return (await rows('task dismiss', db.from('client_tasks').update({ status: 'dismissed' }).in('id', [...taskIds]).eq('status', 'pending').select('id'))).length;
  }

  async function purgeWorking(envelopeId: string): Promise<number> {
    const paths = await walkWorking(deps.storage, envelopeId);
    await deps.storage.removeWorking(paths);
    await call(db, 'esign_delete_signature_images_for_envelope', { p_envelope_id: envelopeId });
    await run('source clear', db.from('esign_envelopes').update({ source_pdf_path: null }).eq('id', envelopeId));
    return paths.length;
  }

  async function sendSummary(log: Logger, summary: Array<{ title: string; signersExpired: number }>, ids: string[], atIso: string) {
    try {
      const owner = await deps.ownerEmail();
      if (!owner) return;
      const mailer = await createMailer(deps, log);
      await mailer.send(owner, expirySummaryEmail({ envelopes: summary, esignUrl: `${(deps.siteUrl ?? '').replace(/\/+$/, '')}/esign` }), {
        tags: { kind: 'esign_expired_summary' },
        idempotencyKey: `esign_expired_summary:${atIso.slice(0, 10)}:${await sha256Hex([...ids].sort().join(','))}`,
      });
    } catch (err) {
      log.error('expiry summary not sent', err);
    }
  }
}
