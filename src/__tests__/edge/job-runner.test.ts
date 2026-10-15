// @vitest-environment node
// The job-runner edge handler. The queue rules run against the real migrations in
// PGlite (claim, complete and fail are the 0001 functions, called as service_role); only
// the callee edge functions are faked, as Responses.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/harness';
import {
  CLAIM_SECONDS,
  createJobRunnerHandler,
  INVOKE_TIMEOUT_MS,
  jobErrorText,
  MAX_PER_TICK,
  type ClaimedJob,
  type JobRunnerDeps,
} from '../../../supabase/functions/job-runner/handler';
import { JOB_KINDS, JOB_ROUTES, payloadMatches, routeFor } from '../../../supabase/functions/job-runner/kinds';
import {
  CREDENTIALS,
  CRON_SECRET,
  describeEdgeContract,
  edgeRequest,
  fakeOwnerAuth,
  throwInternal,
} from './contract';

let db: PGlite;

/** One committed statement as the server (service_role), like the edge client. */
async function asServer<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    rows = (await tx.query<T>(sql, params)).rows;
  });
  return rows;
}

const ok = (body: unknown = { sent: 2 }) => new Response(JSON.stringify(body), { status: 200 });

interface Harness extends JobRunnerDeps {
  logs: string[];
  invoked: Array<{ name: string; body: unknown; signal: AbortSignal }>;
}

function deps(over: Partial<JobRunnerDeps> = {}): Harness {
  const logs: string[] = [];
  const invoked: Harness['invoked'] = [];
  return {
    logs,
    invoked,
    allowedOrigins: ['http://localhost:5173'],
    cronSecret: CRON_SECRET,
    authorizeOwner: fakeOwnerAuth(),
    async claim(limit, seconds) {
      const rows = await asServer<{ v: ClaimedJob }>('SELECT v FROM public.claim_next_jobs($1, $2) v', [limit, seconds]);
      return rows.map((r) => r.v);
    },
    async complete(id, token, result) {
      const [row] = await asServer<{ v: boolean }>('SELECT public.complete_job($1, $2, $3) AS v', [id, token, JSON.stringify(result)]);
      return row.v;
    },
    async fail(id, token, message) {
      const [row] = await asServer<{ v: { reason?: string } }>('SELECT public.fail_job($1, $2, $3) AS v', [id, token, message]);
      return row.v.reason !== 'claim_not_live';
    },
    async invoke(name, body, signal) {
      invoked.push({ name, body, signal });
      return ok();
    },
    async callSql(fn) {
      const [row] = await asServer<{ v: unknown }>(`SELECT public.${fn}() AS v`);
      return row.v;
    },
    logSink: (_level, line) => logs.push(line),
    ...over,
  };
}

const run = async (d: JobRunnerDeps, headers: Record<string, string> = CREDENTIALS.cron) => {
  const res = await createJobRunnerHandler(d)(edgeRequest({ origin: null, headers, body: '{}' }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

async function enqueue(provider: string, action: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = ['provider', 'action', ...Object.keys(extra)];
  const vals = [provider, action, ...Object.values(extra)];
  const [row] = await asServer<{ id: string }>(
    `INSERT INTO public.jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return row.id;
}

async function job(id: string) {
  const [row] = await asServer<{ status: string; attempts: number; last_error: string | null; result: unknown }>(
    'SELECT status, attempts, last_error, result FROM public.jobs WHERE id = $1',
    [id],
  );
  return row;
}

beforeAll(async () => {
  db = await createDb();
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('00000000-0000-4000-8000-000000000001', 'owner@example.test'),
      ('00000000-0000-4000-8000-000000000002', 'system@example.test');
    INSERT INTO public.org_profile (display_name, owner_user_id, system_user_id)
      VALUES ('Example Co', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');`);
}, 60_000);

beforeEach(async () => {
  await db.exec('DELETE FROM public.jobs');
});

describeEdgeContract({
  name: 'job-runner (cron)',
  handler: createJobRunnerHandler(deps()),
  failingHandler: createJobRunnerHandler(deps({ claim: throwInternal })),
  credentials: CREDENTIALS.cron,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'none' },
});

describeEdgeContract({
  name: 'job-runner (owner)',
  handler: createJobRunnerHandler(deps()),
  failingHandler: createJobRunnerHandler(deps({ claim: throwInternal })),
  credentials: CREDENTIALS.owner,
  wrongPrincipal: CREDENTIALS.client,
  body: { kind: 'none' },
});

describe('job-runner: the kinds', () => {
  it('routes exactly the four scheduled kinds, each to its fixed place', () => {
    expect([...JOB_KINDS].sort()).toEqual(['esign:expire_envelopes', 'needs:reminder_dispatch', 'ops:maintenance', 'portal:daily_digest']);
    expect(JOB_ROUTES['portal:daily_digest']).toEqual({ kind: 'function', name: 'send-portal-digest', payload: {} });
    expect(JOB_ROUTES['needs:reminder_dispatch']).toEqual({ kind: 'function', name: 'needs-reminder-dispatcher', payload: {} });
    expect(JOB_ROUTES['esign:expire_envelopes']).toEqual({ kind: 'function', name: 'esign-expire-envelopes', payload: {} });
    expect(JOB_ROUTES['ops:maintenance']).toEqual({
      kind: 'sql',
      functions: ['cleanup_core_operational_rows', 'cleanup_aged_audit_logs', 'cleanup_aged_client_activity', 'cleanup_read_client_messages', 'auto_archive_done_work_items'],
      payload: {},
    });
  });

  it('knows no kind by an inherited name', () => {
    expect(routeFor('constructor')).toBeNull();
    expect(routeFor('toString')).toBeNull();
  });

  it('every SQL route names a function the server may call', async () => {
    for (const route of Object.values(JOB_ROUTES)) {
      if (route.kind !== 'sql') continue;
      for (const fn of route.functions) {
        const [row] = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [`public.${fn}()`])).rows;
        expect([fn, row.ok]).toEqual([fn, true]);
      }
    }
  });

  it('claims at most what claim_next_jobs allows', () => {
    expect(MAX_PER_TICK).toBeGreaterThan(0);
    expect(MAX_PER_TICK).toBeLessThanOrEqual(100);
    expect(CLAIM_SECONDS * 1000).toBeGreaterThan(INVOKE_TIMEOUT_MS);
    expect(INVOKE_TIMEOUT_MS).toBeLessThan(150_000);
  });
});

describe('job-runner: a tick', () => {
  it('claims a due job, calls its function with the payload, and records the answer as the result', async () => {
    const id = await enqueue('portal', 'daily_digest');
    const d = deps();
    const { status, body } = await run(d);
    expect(status).toBe(200);
    expect(body).toEqual({ claimed: 1, succeeded: 1, failed: 0, superseded: 0 });
    expect(d.invoked.map((c) => [c.name, c.body])).toEqual([['send-portal-digest', {}]]);
    expect(d.invoked[0].signal).toBeInstanceOf(AbortSignal);
    expect(await job(id)).toMatchObject({ status: 'success', attempts: 1, last_error: null, result: { sent: 2 } });
  });

  it('runs the maintenance kind in SQL and stores what each function removed', async () => {
    await asServer(`INSERT INTO public.auth_rate_limits (action, created_at) VALUES ('old', now() - interval '8 days')`);
    const id = await enqueue('ops', 'maintenance');
    const d = deps();
    expect((await run(d)).body).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(d.invoked).toEqual([]);
    const { result } = await job(id);
    expect(result).toEqual({
      cleanup_core_operational_rows: { jobs_success: 0, jobs_dead: 0, rate_limits: 1, csp_reports: 0, dev_outbox: 0 },
      cleanup_aged_audit_logs: { audit_logs: 0 },
      cleanup_aged_client_activity: { client_activity: 0 },
      cleanup_read_client_messages: 0,
      auto_archive_done_work_items: 0,
    });
  });

  it('leaves a job that is not due yet', async () => {
    const id = await enqueue('portal', 'daily_digest', { scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await run(deps())).body).toEqual({ claimed: 0, succeeded: 0, failed: 0, superseded: 0 });
    expect((await job(id)).status).toBe('pending');
  });

  it('runs at most MAX_PER_TICK jobs', async () => {
    for (let i = 0; i < MAX_PER_TICK + 2; i++) await enqueue('portal', 'daily_digest');
    expect((await run(deps())).body).toMatchObject({ claimed: MAX_PER_TICK, succeeded: MAX_PER_TICK });
  });

  it('runs every claimed job even when one fails', async () => {
    const a = await enqueue('portal', 'daily_digest');
    const b = await enqueue('needs', 'reminder_dispatch');
    const d = deps({ invoke: async (name) => (name === 'send-portal-digest' ? new Response('', { status: 500 }) : ok()) });
    expect((await run(d)).body).toEqual({ claimed: 2, succeeded: 1, failed: 1, superseded: 0 });
    expect((await job(a)).status).toBe('pending');
    expect((await job(b)).status).toBe('success');
  });
});

describe('job-runner: failures', () => {
  it('a throw goes to fail_job, redacted, and the job is retried later', async () => {
    const id = await enqueue('esign', 'expire_envelopes');
    const d = deps({
      invoke: async () => {
        throw new Error('could not reach ada@example.com with key provider-secret-0123456789');
      },
    });
    expect((await run(d)).body).toEqual({ claimed: 1, succeeded: 0, failed: 1, superseded: 0 });
    const row = await job(id);
    expect(row.status).toBe('pending');
    expect(row.last_error).toContain('could not reach');
    expect(row.last_error).not.toContain('ada@example.com');
    expect(row.last_error).not.toContain('provider-secret-0123456789');
    expect(d.logs.join('\n')).not.toContain('ada@example.com');
  });

  it('a callee that answers non-2xx is recorded by its status, never its body', async () => {
    const id = await enqueue('needs', 'reminder_dispatch');
    const d = deps({ invoke: async () => new Response('{"error":"row for ada@example.com failed"}', { status: 502 }) });
    await run(d);
    const row = await job(id);
    expect(row.last_error).toBe('needs-reminder-dispatcher answered 502');
  });

  it('a callee that does not exist yet (404) fails the job, not the runner', async () => {
    const id = await enqueue('esign', 'expire_envelopes');
    const { status, body } = await run(deps({ invoke: async () => new Response('Not found', { status: 404 }) }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ failed: 1 });
    expect((await job(id)).last_error).toBe('esign-expire-envelopes answered 404');
  });

  it('a callee that times out fails the job', async () => {
    const id = await enqueue('portal', 'daily_digest');
    const d = deps({
      invoke: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    expect((await run(d)).body).toMatchObject({ failed: 1 });
    expect((await job(id)).last_error).toMatch(/timeout/);
  });

  it('an unknown kind fails through the backoff, then dies on its last attempt', async () => {
    const id = await enqueue('shop', 'sync', { max_attempts: 1 });
    expect((await run(deps())).body).toMatchObject({ failed: 1 });
    expect(await job(id)).toMatchObject({ status: 'dead', last_error: 'unknown job kind shop:sync' });
  });

  it('a callee answer that is not a JSON object, or too large, is not stored as such', async () => {
    const a = await enqueue('portal', 'daily_digest');
    await run(deps({ invoke: async () => new Response('done', { status: 200 }) }));
    expect((await job(a)).result).toBeNull();
    const b = await enqueue('portal', 'daily_digest');
    await run(deps({ invoke: async () => ok({ ids: 'x'.repeat(20_000) }) }));
    expect((await job(b)).result).toEqual({ result_too_large: true });
  });

  it('jobErrorText bounds and redacts', () => {
    expect(jobErrorText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(1000);
    expect(jobErrorText({ code: '23505', message: 'duplicate key value: "ada@example.com"' })).toBe('[23505] duplicate key value: "[redacted]"');
  });
});

describe('job-runner: payloads', () => {
  it.each([
    ['an extra field', { contact_id: '00000000-0000-4000-8000-000000000009' }],
    ['a field shaped like a command', { url: 'https://elsewhere.example/' }],
  ])("a payload outside its kind's schema (%s) fails the job, and nothing is called", async (_what, payload) => {
    const id = await enqueue('portal', 'daily_digest', { payload: JSON.stringify(payload) });
    const d = deps();
    expect((await run(d)).body).toMatchObject({ failed: 1, succeeded: 0 });
    expect(d.invoked).toEqual([]);
    expect((await job(id)).last_error).toBe('payload does not match job kind portal:daily_digest');
  });

  it('the maintenance kind refuses one too, before any SQL runs', async () => {
    await enqueue('ops', 'maintenance', { payload: JSON.stringify({ days: 1 }) });
    const callSql = vi.fn(async () => ({}));
    expect((await run(deps({ callSql }))).body).toMatchObject({ failed: 1 });
    expect(callSql).not.toHaveBeenCalled();
  });

  it('every current kind takes an empty payload', () => {
    for (const route of Object.values(JOB_ROUTES)) expect(route.payload).toEqual({});
  });

  it("payloadMatches: only the schema's fields, each of its type", () => {
    const schema = { contact_id: 'uuid', mode: 'code', limit: 'integer', dry: 'boolean' } as const;
    expect(payloadMatches(schema, null)).toBe(true);
    expect(payloadMatches(schema, {})).toBe(true);
    expect(payloadMatches(schema, { contact_id: '00000000-0000-4000-8000-000000000009', mode: 'all', limit: 5, dry: true })).toBe(true);
    expect(payloadMatches(schema, { contact_id: 'x' })).toBe(false);
    expect(payloadMatches(schema, { mode: 'Ada Lovelace' })).toBe(false);
    expect(payloadMatches(schema, { limit: 1.5 })).toBe(false);
    expect(payloadMatches(schema, { dry: 'yes' })).toBe(false);
    expect(payloadMatches(schema, { other: 1 })).toBe(false);
    expect(payloadMatches(schema, { constructor: 1 })).toBe(false);
    expect(payloadMatches(schema, [])).toBe(false);
    expect(payloadMatches(schema, 'x')).toBe(false);
  });
});

describe('job-runner: recording the outcome', () => {
  it('a job that finished after its claim was reclaimed is superseded', async () => {
    await enqueue('portal', 'daily_digest');
    expect((await run(deps({ complete: async () => false }))).body).toEqual({ claimed: 1, succeeded: 0, failed: 0, superseded: 1 });
  });

  it('a success that cannot be recorded counts as failed, and is never written back as a job failure', async () => {
    const id = await enqueue('portal', 'daily_digest');
    const fail = vi.fn(async () => true);
    const d = deps({
      complete: async () => {
        throw new Error('connection reset');
      },
      fail,
    });
    expect((await run(d)).body).toEqual({ claimed: 1, succeeded: 0, failed: 1, superseded: 0 });
    expect(fail).not.toHaveBeenCalled();
    expect((await job(id)).status).toBe('running');
  });

  it('a failure reported after the claim was reclaimed is superseded', async () => {
    await enqueue('portal', 'daily_digest');
    const d = deps({ invoke: async () => new Response('', { status: 500 }), fail: async () => false });
    expect((await run(d)).body).toEqual({ claimed: 1, succeeded: 0, failed: 0, superseded: 1 });
  });

  it('a stale token cannot record over the live claim (the database refuses it)', async () => {
    const id = await enqueue('portal', 'daily_digest');
    const [first] = await deps().claim(10, 60);
    await asServer(`UPDATE public.jobs SET claimed_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const d = deps({
      // The tick reclaims the job (new token); this worker reports with the old one.
      complete: async (jobId, _token, result) => deps().complete(jobId, first.claim_token, result),
    });
    expect((await run(d)).body).toMatchObject({ superseded: 1 });
    expect((await job(id)).status).toBe('running');
  });

  it('a failure that cannot be recorded counts as failed', async () => {
    await enqueue('portal', 'daily_digest');
    const d = deps({
      invoke: async () => new Response('', { status: 500 }),
      fail: async () => {
        throw new Error('connection reset');
      },
    });
    expect((await run(d)).body).toMatchObject({ failed: 1 });
  });

  it('a claim error fails the tick (500, generic) instead of reporting an idle queue', async () => {
    const res = await createJobRunnerHandler(deps({ claim: throwInternal }))(edgeRequest({ origin: null, headers: CREDENTIALS.cron }));
    expect(res.status).toBe(500);
  });
});
