// job-runner: the one drainer of public.jobs. pg_cron calls it every minute with the cron
// secret (supabase/schedules.sql); the owner can also call it from the Jobs page ("Run
// queue now"), which is the only way to drain the queue on a project whose schedules are
// not installed yet.
//
// Each tick claims up to MAX_PER_TICK due jobs (claim_next_jobs: a lease and a fresh
// claim token per job), runs them side by side, and records each outcome with that token
// (complete_job / fail_job). Routing is kinds.ts. The rules, each kept from incidents:
//   - A job that throws goes to fail_job, which retries it with backoff (60 s, 120 s, ...)
//     and marks it dead after max_attempts. An unknown kind is no different: it is dead
//     after about a quarter of an hour, not at once.
//   - The error text stored in last_error, shown to the owner and kept for months, is
//     the error's code and message with personal data and credentials redacted. A callee
//     that answers non-2xx is recorded by its status alone, never by its body.
//   - Recording a success happens OUTSIDE the job's try: a failure to record a success
//     must never be written back as a job failure, which would re-run work that already
//     happened. Such a job is counted failed for this tick; its lease lapses and the claim
//     sweep takes it from there.
//   - complete_job answering false, or fail_job answering claim_not_live, means the lease
//     expired and the job was reclaimed: this claim's outcome no longer counts
//     (superseded).
//   - A payload outside its kind's schema (kinds.ts) fails the job; nothing is called.
//   - A claim error is not "nothing to do": the tick fails (500), so the failure shows in
//     net._http_response instead of looking like an idle queue.
// The runner writes no audit rows: scheduled work is not a person acting.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler } from '../_shared/handler.ts';
import { errSummary, redactText, type Logger, type LogSink } from '../_shared/log.ts';
import { payloadMatches, routeFor } from './kinds.ts';

/** claim_next_jobs refuses more than 100; ten keeps a tick well inside the wall clock. */
export const MAX_PER_TICK = 10;
/** The lease. Longer than the edge wall clock, so a killed tick's job waits it out. */
export const CLAIM_SECONDS = 300;
/** Below the edge wall clock (150 s on the free plan), so a slow callee fails cleanly. */
export const INVOKE_TIMEOUT_MS = 110_000;
/** A callee's answer is stored as the job's result; anything larger is not kept. */
export const MAX_RESULT_BYTES = 16_384;
const MAX_ERROR_CHARS = 1000;

/** A claimed row, as claim_next_jobs returns it (the columns the runner reads). */
export interface ClaimedJob {
  id: string;
  provider: string;
  action: string;
  payload: Record<string, unknown> | null;
  claim_token: string;
}

export interface TickSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  superseded: number;
}

export interface JobRunnerDeps {
  allowedOrigins: string[];
  /** CRON_SHARED_SECRET. */
  cronSecret: string | null | undefined;
  /** _shared/auth.ts authorizeOwner, bound to the function's clients. */
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  /** claim_next_jobs. Throws on an RPC error. */
  claim(limit: number, claimSeconds: number): Promise<ClaimedJob[]>;
  /** complete_job: true when recorded, false when the claim is no longer live. Throws on an RPC error. */
  complete(jobId: string, claimToken: string, result: unknown): Promise<boolean>;
  /** fail_job: false when the claim is no longer live. Throws on an RPC error. */
  fail(jobId: string, claimToken: string, error: string): Promise<boolean>;
  /** POST `body` to the edge function `name` with the cron secret. Rejects on a network error or abort. */
  invoke(name: string, body: unknown, signal: AbortSignal): Promise<Response>;
  /** A server-only SQL function, called with no arguments. Throws on an RPC error. */
  callSql(fn: string): Promise<unknown>;
  logSink?: LogSink;
}

type Outcome = 'success' | 'failed' | 'superseded';

/** What a thrown value becomes in last_error: code and message, redacted, bounded. */
export function jobErrorText(err: unknown): string {
  return redactText(errSummary(err)).slice(0, MAX_ERROR_CHARS);
}

class CalleeError extends Error {
  constructor(name: string, status: number) {
    super(`${name} answered ${status}`);
    this.name = 'CalleeError';
  }
}

async function readResult(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) return { result_too_large: true };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function runJob(deps: JobRunnerDeps, kind: string, job: ClaimedJob): Promise<unknown> {
  const route = routeFor(kind);
  if (!route) throw new Error(`unknown job kind ${kind}`);
  // Before anything runs: a payload outside the kind's schema never reaches a callee.
  if (!payloadMatches(route.payload, job.payload)) throw new Error(`payload does not match job kind ${kind}`);
  if (route.kind === 'sql') {
    const results: Record<string, unknown> = {};
    for (const fn of route.functions) results[fn] = await deps.callSql(fn);
    return results;
  }
  const res = await deps.invoke(route.name, job.payload ?? {}, AbortSignal.timeout(INVOKE_TIMEOUT_MS));
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CalleeError(route.name, res.status);
  }
  return readResult(res);
}

async function recordFailure(deps: JobRunnerDeps, job: ClaimedJob, text: string, log: Logger): Promise<Outcome> {
  try {
    if (!(await deps.fail(job.id, job.claim_token, text))) {
      log.warn('job failed after its lease was reclaimed', { job_id: job.id });
      return 'superseded';
    }
  } catch (err) {
    log.error('job failure could not be recorded', err, { job_id: job.id });
  }
  return 'failed';
}

/** Runs one claimed job and records its outcome. Never rejects. */
async function runOne(deps: JobRunnerDeps, job: ClaimedJob, log: Logger): Promise<Outcome> {
  const kind = `${job.provider}:${job.action}`;
  let result: unknown;
  try {
    result = await runJob(deps, kind, job);
  } catch (err) {
    log.error('job failed', err, { job_id: job.id, kind });
    return recordFailure(deps, job, jobErrorText(err), log);
  }

  // Outside the job's try: see the header.
  try {
    if (!(await deps.complete(job.id, job.claim_token, result ?? null))) {
      log.warn('job finished after its lease was reclaimed', { job_id: job.id, kind });
      return 'superseded';
    }
  } catch (err) {
    log.error('job succeeded but could not be recorded', err, { job_id: job.id, kind });
    return 'failed';
  }
  return 'success';
}

export async function tick(deps: JobRunnerDeps, log: Logger): Promise<TickSummary> {
  const jobs = await deps.claim(MAX_PER_TICK, CLAIM_SECONDS);
  const outcomes = await Promise.all(jobs.map((job) => runOne(deps, job, log)));
  const tally = (o: Outcome) => outcomes.filter((x) => x === o).length;
  return { claimed: jobs.length, succeeded: tally('success'), failed: tally('failed'), superseded: tally('superseded') };
}

export function createJobRunnerHandler(deps: JobRunnerDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'job-runner',
    allowedOrigins: deps.allowedOrigins,
    auth: { cron: { secret: deps.cronSecret }, owner: deps.authorizeOwner },
    // pg_net sends '{}', the Jobs page nothing; neither is read.
    body: 'none',
    logSink: deps.logSink,
    async handle({ json, log }) {
      const summary = await tick(deps, log);
      if (summary.claimed > 0) log.info('tick', { ...summary });
      return json(200, summary);
    },
  });
}
