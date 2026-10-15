// @vitest-environment node
// supabase/schedules.sql is applied outside the migrations (PGlite has no pg_cron, pg_net
// or Vault), so its rules are checked on the text, and every function it calls directly
// is checked against the catalog of the fully migrated database.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from '@/__tests__/db/harness';
import { JOB_KINDS } from '../../../../supabase/functions/job-runner/kinds';
import {
  cronSecretFrom,
  failureMessage,
  JOB_PREFIX,
  LISTED_SQL,
  projectUrlFrom,
  readMarker,
  REMOVE_SQL,
  ROTATE_ADVICE,
  scheduleNames,
  scrub,
  sqlLiteral,
  RESPONSE_POLL_MS,
  RESPONSE_WAIT_MS,
  responseSql,
  TEST_TICK_SQL,
  TICK_TIMEOUT_MS,
  waitForResponse,
  vaultSql,
  vaultUpsertSql,
} from '../../../../scripts/install-schedules.mjs';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// Normalised: a Windows checkout may hand the file over with CRLF endings.
const SQL = readFileSync(path.join(ROOT, 'supabase', 'schedules.sql'), 'utf8').replace(/\r\n/g, '\n');

/** Every cron.schedule call, split into its name, cron expression and command. */
function parseSchedules(sql: string) {
  return [...sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$job\$([\s\S]*?)\$job\$\s*\)/g)].map((m) => ({
    name: m[1],
    when: m[2],
    command: m[3],
  }));
}

const code = (sql: string) => sql.replace(/--[^\n]*/g, '');
const jobs = parseSchedules(SQL);
const ENQUEUE = /INSERT INTO public\.jobs \(provider, action\)\s+SELECT '([a-z_]+)', '([a-z_]+)'\s+WHERE NOT EXISTS \(SELECT 1 FROM public\.jobs\s+WHERE provider = '([a-z_]+)' AND action = '([a-z_]+)' AND status IN \('pending', 'running'\)\);/;

/** What a schedules file breaks, one line per problem. */
function scheduleProblems(sql: string): string[] {
  const parsed = parseSchedules(sql);
  const out: string[] = [];
  if (parsed.length !== (code(sql).match(/cron\.schedule\(/g) ?? []).length) out.push('a cron.schedule call does not use the $job$ form');
  const names = parsed.map((j) => j.name);
  for (const name of names) {
    if (!name.startsWith(JOB_PREFIX)) out.push(`${name}: not prefixed ${JOB_PREFIX}`);
    if (names.indexOf(name) !== names.lastIndexOf(name)) out.push(`${name}: scheduled twice`);
  }
  for (const job of parsed) {
    if (job.when.split(' ').length !== 5) out.push(`${job.name}: '${job.when}' is not a five-field cron expression`);
    const cmd = code(job.command);
    if (/INSERT INTO public\.jobs/.test(cmd)) {
      const m = ENQUEUE.exec(cmd);
      if (!m) out.push(`${job.name}: an enqueue without the one-waiting-row guard`);
      else if (m[1] !== m[3] || m[2] !== m[4]) out.push(`${job.name}: the guard checks another kind`);
      else if (!(JOB_KINDS as string[]).includes(`${m[1]}:${m[2]}`)) out.push(`${job.name}: ${m[1]}:${m[2]} is not a job-runner kind`);
    }
    for (const call of cmd.match(/net\.http_post\([\s\S]*?\);/g) ?? []) {
      if (!/timeout_milliseconds\s*:=\s*\d+/.test(call)) out.push(`${job.name}: net.http_post without timeout_milliseconds`);
    }
    if (/net\.http_post/.test(cmd) && !/vault\.decrypted_secrets/.test(cmd)) out.push(`${job.name}: posts without reading Vault at run time`);
    if (/vault\.decrypted_secrets/.test(cmd) && !/RAISE EXCEPTION/.test(cmd)) out.push(`${job.name}: a missing Vault value does not fail the run`);
  }
  const body = code(sql);
  if (/vault\.decrypted_secrets/.test(body.replace(/\$job\$[\s\S]*?\$job\$/g, ''))) out.push('Vault is read outside a job command');
  if (/\b[0-9a-f]{32,}\b/i.test(body)) out.push('a long hex string (a secret?)');
  if (/supabase\.(co|in)\b/i.test(body)) out.push('a project host');
  if (/%L/.test(body)) out.push('format(%L): a value baked into a command');
  return out;
}

/** The public functions a schedules file calls directly. */
const directCalls = (sql: string) =>
  parseSchedules(sql).flatMap((j) => [...code(j.command).matchAll(/\bpublic\.([a-z_]+)\(\)/g)].map((m) => m[1]));

describe('supabase/schedules.sql', () => {
  it('passes every rule', () => {
    expect(jobs.length).toBeGreaterThan(0);
    expect(scheduleProblems(SQL)).toEqual([]);
  });

  it('enqueues every job-runner kind once a day, and ticks every minute', () => {
    const enqueued = jobs.flatMap((j) => {
      const m = ENQUEUE.exec(code(j.command));
      return m ? [`${m[1]}:${m[2]}`] : [];
    });
    expect(enqueued.sort()).toEqual([...JOB_KINDS].sort());
    const tick = jobs.find((j) => /net\.http_post/.test(j.command));
    expect(tick?.when).toBe('* * * * *');
    expect(tick?.command).toContain("v_url || '/functions/v1/job-runner'");
  });

  it('calls only functions the migrations create', async () => {
    const calls = directCalls(SQL);
    expect(calls).toContain('auto_end_stale_impersonation_sessions');
    const db = await createDb();
    for (const fn of calls) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1 AND pronargs = 0`,
        [fn],
      );
      expect([fn, rows[0].n]).toEqual([fn, 1]);
    }
  }, 60_000);

  // Each rule, broken once: the check must name it.
  const tick = jobs.find((j) => /net\.http_post/.test(j.command))!.command;
  const mutations: Array<[string, string, RegExp]> = [
    ['an unguarded enqueue', SQL.replace(/WHERE NOT EXISTS \(SELECT 1 FROM public\.jobs\s+WHERE provider = 'portal'[^;]*;/, ';'), /open-crm-portal-digest: an enqueue without/],
    ['a guard on another kind', SQL.replace("WHERE provider = 'esign' AND action = 'expire_envelopes'", "WHERE provider = 'esign' AND action = 'other'"), /open-crm-esign-expire: the guard checks another kind/],
    ['an unknown kind', SQL.replaceAll("'needs', 'reminder_dispatch'", "'needs', 'nudge'").replace("action = 'reminder_dispatch'", "action = 'nudge'"), /needs:nudge is not a job-runner kind/],
    ['a name without the prefix', SQL.replace("'open-crm-maintenance'", "'maintenance'"), /maintenance: not prefixed/],
    ['a name used twice', SQL.replace("'open-crm-esign-expire'", "'open-crm-maintenance'"), /open-crm-maintenance: scheduled twice/],
    ['no timeout', SQL.replace(',\n    timeout_milliseconds := 120000', ''), /net\.http_post without timeout_milliseconds/],
    ['the secret baked in', SQL.replace(tick, tick.replace(/SELECT decrypted_secret INTO v_secret[^;]*;/, `v_secret := '${'ab'.repeat(32)}';`)), /long hex/],
    ['no Vault read at all', SQL.replace(tick, `PERFORM net.http_post(url := 'https://x.example/functions/v1/job-runner', timeout_milliseconds := 1);`), /posts without reading Vault/],
    ['a missing secret not failing', SQL.replace(/RAISE EXCEPTION [^;]*;/, 'RETURN;'), /does not fail the run/],
    ['a project host', SQL.replace("v_url || '/functions/v1/job-runner'", "'https://abcd.supabase.co/functions/v1/job-runner'"), /a project host/],
    ['a %L format', `${SQL}\nSELECT cron.schedule('open-crm-x', '0 0 * * *', $job$ SELECT format('%L', 1); $job$);`, /%L/],
    ['a bad cron expression', SQL.replace("'45 3 * * *'", "'45 3 * *'"), /not a five-field cron expression/],
  ];

  it.each(mutations)('catches %s', (_what, sql, expected) => {
    const found = scheduleProblems(sql);
    expect(found.some((line) => expected.test(line)), found.join('\n') || '(nothing reported)').toBe(true);
  });
});

describe('install-schedules: the pure half', () => {
  const SECRET = 'a1'.repeat(32);

  it('stores each Vault secret by updating it when present and creating it when not', () => {
    const sql = vaultUpsertSql('project_url', 'https://abc.example.com');
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'project_url')");
    expect(sql).toContain("PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'project_url'), 'https://abc.example.com')");
    expect(sql).toContain("PERFORM vault.create_secret('https://abc.example.com', 'project_url')");
    const both = vaultSql({ url: 'https://abc.example.com', secret: SECRET });
    expect(both).toContain("name = 'project_url'");
    expect(both).toContain("name = 'cron_shared_secret'");
  });

  it('quotes values safely and refuses an odd secret name', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(vaultUpsertSql('project_url', "x'); DROP TABLE t; --")).toContain("'x''); DROP TABLE t; --'");
    expect(() => vaultUpsertSql("name'; --", 'x')).toThrow(/not a Vault secret name/);
  });

  it('takes only the origin of the project URL, and refuses plain http to a remote host', () => {
    expect(projectUrlFrom('VITE_SUPABASE_URL=https://abc.example.com/rest/v1?x=$vault$\n')).toBe('https://abc.example.com');
    expect(projectUrlFrom('VITE_SUPABASE_URL=http://127.0.0.1:54321\n')).toBe('http://127.0.0.1:54321');
    expect(projectUrlFrom('VITE_SUPABASE_URL=http://abc.example.com\n')).toBeInstanceOf(Error);
    expect(projectUrlFrom('VITE_SUPABASE_URL=not a url\n')).toBeInstanceOf(Error);
    expect(projectUrlFrom('OTHER=1\n')).toBeInstanceOf(Error);
  });

  it('reads the cron secret, refuses a short or odd one, and never puts it in a message', () => {
    expect(cronSecretFrom(`CRON_SHARED_SECRET=${SECRET}\n`)).toBe(SECRET);
    for (const bad of ['short1', `${SECRET}$vault$`, `${SECRET}'`]) {
      const out = cronSecretFrom(`CRON_SHARED_SECRET=${bad}\n`);
      expect(out).toBeInstanceOf(Error);
      expect((out as Error).message).not.toContain(bad);
    }
    expect(cronSecretFrom('')).toBeInstanceOf(Error);
  });

  it('scrubs the secret from anything it prints', () => {
    expect(scrub(`ERROR near "${SECRET}" in ${SECRET}`, [SECRET])).toBe('ERROR near "[secret]" in [secret]');
  });

  it('reads the marked answer from the CLI output, table or JSON', () => {
    expect(readMarker('| v |\n|---|\n| oc-tick:200:end |', 'oc-tick')).toBe('200');
    expect(readMarker('[{"v":"oc-listed:open-crm-a,open-crm-b:end"}]', 'oc-listed')).toBe('open-crm-a,open-crm-b');
    expect(readMarker('nothing here', 'oc-tick')).toBeNull();
    expect(LISTED_SQL).toContain(`LIKE '${JOB_PREFIX}%'`);
  });

  it("the test tick is the schedule's request, reads Vault in SQL, and answers its own request id", () => {
    const tick = jobs.find((j) => /net\.http_post/.test(j.command))!.command;
    expect(tick).toContain("'/functions/v1/job-runner'");
    expect(tick).toContain("'x-cron-secret'");
    expect(tick).toContain(`timeout_milliseconds := ${TICK_TIMEOUT_MS}`);
    expect(TEST_TICK_SQL).toContain("'/functions/v1/job-runner'");
    expect(TEST_TICK_SQL).toContain("jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_shared_secret')");
    expect(TEST_TICK_SQL).toContain("(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')");
    expect(TEST_TICK_SQL).toContain(`timeout_milliseconds := ${TICK_TIMEOUT_MS}`);
    expect(TEST_TICK_SQL).toMatch(/^SELECT 'oc-req:' \|\| net\.http_post\(/);
    expect(readMarker('| v |\n|---|\n| oc-req:4711:end |', 'oc-req')).toBe('4711');
  });

  it('checks the response of that one request, never the latest of all traffic', () => {
    const sql = responseSql('4711');
    expect(sql).toContain('WHERE id = 4711');
    expect(sql).not.toMatch(/ORDER BY|LIMIT|created/);
    expect(() => responseSql('1; DROP TABLE x')).toThrow(/request id/);
    expect(() => responseSql('')).toThrow(/request id/);
  });

  it('polls past pg_net timeout before giving up, and stops at the first answer', async () => {
    expect(RESPONSE_WAIT_MS).toBeGreaterThan(TICK_TIMEOUT_MS);
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const reads: number[] = [];
    const late = await waitForResponse(async () => { reads.push(t); return t >= 130_000 ? '200' : 'pending'; }, clock);
    expect(late).toBe('200');
    expect(reads.at(-1)).toBe(130_000);

    t = 0;
    let polls = 0;
    expect(await waitForResponse(async () => { polls += 1; return 'pending'; }, clock)).toBeNull();
    expect(t).toBe(RESPONSE_WAIT_MS);
    expect(polls).toBe(RESPONSE_WAIT_MS / RESPONSE_POLL_MS + 1);

    t = 0;
    expect(await waitForResponse(async () => 'failed', clock)).toBe('failed');
    expect(t).toBe(0);
  });

  it('lists the job names a schedules file installs, and removes exactly those', () => {
    expect(scheduleNames(SQL)).toEqual(jobs.map((j) => j.name));
    expect(REMOVE_SQL.split('\n')[0]).toBe("SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'open-crm-%';");
  });

  it('--remove also deletes both Vault secrets the install stored, by name', () => {
    expect(REMOVE_SQL.split('\n')[1]).toBe("DELETE FROM vault.secrets WHERE name IN ('project_url', 'cron_shared_secret');");
    for (const name of ['project_url', 'cron_shared_secret']) expect(vaultSql({ url: 'https://x.example.com', secret: SECRET })).toContain(`'${name}'`);
  });

  it('a run that fails after sending the secret says to rotate it; one that fails before does not', () => {
    const err = new Error('supabase db query failed');
    expect(failureMessage(err, false)).toBe('supabase db query failed');
    expect(failureMessage(err, true)).toBe(`supabase db query failed\n${ROTATE_ADVICE}`);
    expect(ROTATE_ADVICE).toContain('rotate CRON_SHARED_SECRET');
    expect(failureMessage('plain', true)).toContain('rotate CRON_SHARED_SECRET');
  });
});
