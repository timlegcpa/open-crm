#!/usr/bin/env node
// npm run schedules:install [-- --remove] [-- --no-wait]
//
// Installs Open CRM's schedules (supabase/schedules.sql) on the linked Supabase project:
//   1. stores the project URL and CRON_SHARED_SECRET in Vault, where the every-minute
//      tick reads them when it runs (never in the job's command text);
//   2. applies supabase/schedules.sql (pg_cron and pg_net, the tick, the daily jobs);
//   3. checks every open-crm-* job is listed, then fires one test tick of its own (the
//      same request the schedule's tick sends, URL and secret read from Vault in SQL),
//      and polls for THAT request's answer for up to 150 seconds (pg_net gives up at
//      120), expecting 200. That is the only place a Vault secret that differs from the
//      functions' CRON_SHARED_SECRET shows: cron itself reports such a run as fine. The
//      test tick is a real tick: job-runner runs whatever jobs are due.
// --no-wait skips step 3's test tick. --remove unschedules every open-crm-* job and
// deletes both Vault secrets instead.
//
// Run after `supabase link`, `db push`, `secrets set --env-file supabase/functions/.env`
// and `functions deploy`, and again whenever CRON_SHARED_SECRET changes. The URL comes
// from .env.local (VITE_SUPABASE_URL) and the secret from supabase/functions/.env, both
// written by `npm run dev:bootstrap`. Queries go through `supabase db query --linked`
// (the Management API; no Docker). The secret is never printed: the SQL that carries it
// is written to a private temporary file, deleted afterwards, and any output that echoes
// it is scrubbed.
//
// One place this script cannot reach: if the Vault statement itself fails on the server
// (a missing vault schema, a permissions error), Postgres may write the failing statement,
// secret literal included, to the project's database logs. So any run that fails after
// the secret was sent ends by saying to rotate CRON_SHARED_SECRET.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from './lib/bootstrap-core.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCHEDULES = resolve(ROOT, 'supabase/schedules.sql');
export const JOB_PREFIX = 'open-crm-';
const MIN_SECRET_LENGTH = 32;

/** A SQL string literal. Values are validated before they get here; quotes are doubled anyway. */
export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The project's origin from .env.local, or an Error saying what is wrong. Only an origin
 * (scheme, host, port) is ever used, so nothing else in the line can reach the SQL.
 */
export function projectUrlFrom(envLocalText) {
  const raw = parseEnv(envLocalText).get('VITE_SUPABASE_URL');
  if (!raw) return new Error('.env.local has no VITE_SUPABASE_URL; run npm run dev:bootstrap first.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return new Error('VITE_SUPABASE_URL in .env.local is not a URL.');
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return new Error('VITE_SUPABASE_URL must be https://<ref>.supabase.co.');
  }
  return url.origin;
}

/** CRON_SHARED_SECRET from supabase/functions/.env, or an Error. Never echoes the value. */
export function cronSecretFrom(functionsEnvText) {
  const secret = parseEnv(functionsEnvText).get('CRON_SHARED_SECRET');
  if (!secret) return new Error('supabase/functions/.env has no CRON_SHARED_SECRET; run npm run dev:bootstrap first.');
  if (secret.length < MIN_SECRET_LENGTH || !/^[A-Za-z0-9]+$/.test(secret)) {
    return new Error(`CRON_SHARED_SECRET must be at least ${MIN_SECRET_LENGTH} letters and digits (the functions refuse anything shorter).`);
  }
  return secret;
}

/** One Vault secret, created when missing and updated in place when present (create_secret refuses a duplicate name). */
export function vaultUpsertSql(name, value) {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`not a Vault secret name: ${name}`);
  const n = sqlLiteral(name);
  const v = sqlLiteral(value);
  return [
    `DO $vault$`,
    `BEGIN`,
    `  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = ${n}) THEN`,
    `    PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = ${n}), ${v});`,
    `  ELSE`,
    `    PERFORM vault.create_secret(${v}, ${n});`,
    `  END IF;`,
    `END`,
    `$vault$;`,
  ].join('\n');
}

/** The SQL that stores both values the tick reads. */
export function vaultSql({ url, secret }) {
  return `${vaultUpsertSql('project_url', url)}\n${vaultUpsertSql('cron_shared_secret', secret)}\n`;
}

/** The job names a schedules file installs, in order. */
export function scheduleNames(sqlText) {
  return [...sqlText.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The Vault secrets the install stores, and --remove deletes. */
export const VAULT_NAMES = ['project_url', 'cron_shared_secret'];

export const REMOVE_SQL =
  `SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE '${JOB_PREFIX}%';\n` +
  `DELETE FROM vault.secrets WHERE name IN (${VAULT_NAMES.map(sqlLiteral).join(', ')});`;

export const ROTATE_ADVICE =
  'The secret was sent before this failed, and a failed statement can land in the database logs: ' +
  'rotate CRON_SHARED_SECRET (put a new value in supabase/functions/.env, run ' +
  'npx supabase secrets set --env-file supabase/functions/.env, then run this again).';

/** What a failed run prints: the error, then the rotation advice once the secret has been sent. */
export function failureMessage(err, secretSent) {
  const message = err instanceof Error ? err.message : String(err);
  return secretSent ? `${message}\n${ROTATE_ADVICE}` : message;
}

/** One marked value per query, so the answer reads the same whatever the CLI's table format. */
export const LISTED_SQL =
  `SELECT 'oc-listed:' || COALESCE(string_agg(jobname, ',' ORDER BY jobname), '') || ':end' AS v ` +
  `FROM cron.job WHERE jobname LIKE '${JOB_PREFIX}%' AND active;`;

/** pg_net's timeout for a tick; supabase/schedules.sql states the same. */
export const TICK_TIMEOUT_MS = 120_000;
/** How long the installer waits for its test tick's answer: longer than pg_net's own timeout. */
export const RESPONSE_WAIT_MS = 150_000;
export const RESPONSE_POLL_MS = 5_000;

/**
 * One tick of the installer's own, the request the schedule's tick sends, answering with
 * its pg_net request id. The URL and secret are read from Vault in SQL; neither is in
 * this text, so a failure here cannot log the secret.
 */
export const TEST_TICK_SQL = [
  `SELECT 'oc-req:' || net.http_post(`,
  `  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/job-runner',`,
  `  headers := jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_shared_secret'), 'Content-Type', 'application/json'),`,
  `  body := '{}'::jsonb,`,
  `  timeout_milliseconds := ${TICK_TIMEOUT_MS})::text || ':end' AS v;`,
].join('\n');

/** The status of one pg_net request: its HTTP code, 'failed' (no code: refused or timed out) or 'pending'. */
export function responseSql(requestId) {
  if (!/^\d+$/.test(String(requestId))) throw new Error(`not a pg_net request id: ${requestId}`);
  return (
    `SELECT 'oc-resp:' || COALESCE((SELECT COALESCE(status_code::text, 'failed') FROM net._http_response ` +
    `WHERE id = ${requestId}), 'pending') || ':end' AS v;`
  );
}

/**
 * Polls `readStatus` until it answers something other than 'pending', or RESPONSE_WAIT_MS
 * has passed (then null). Clock and sleep are injected for the tests.
 */
export async function waitForResponse(readStatus, {
  timeoutMs = RESPONSE_WAIT_MS,
  intervalMs = RESPONSE_POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const start = now();
  for (;;) {
    const status = await readStatus();
    if (status !== 'pending') return status;
    if (now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

/** The value a marked query printed, or null. */
export function readMarker(output, key) {
  const m = new RegExp(`${key}:([^\\s|"]*?):end`).exec(output);
  return m ? m[1] : null;
}

/** `text` with every occurrence of each secret replaced. */
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('[secret]');
  return out;
}

/**
 * Runs `sql` on the linked project. The SQL goes through a private temporary file, never
 * the command line (where a secret would show in the process list, and a shell would
 * mangle the quoting), and the file is deleted however the run ends. A failure throws with
 * the CLI's output (secrets scrubbed) in the message. `npm run demo:seed` uses it too.
 */
export function query(sql, secrets = []) {
  const dir = mkdtempSync(join(tmpdir(), 'open-crm-query-'));
  try {
    const file = join(dir, 'query.sql');
    writeFileSync(file, sql, { mode: 0o600 });
    // npx is a .cmd on Windows, which only a shell runs; the path is quoted for that shell.
    const windows = process.platform === 'win32';
    const res = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '-f', windows ? `"${file}"` : file], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: windows,
    });
    const output = scrub(`${res.stdout ?? ''}${res.stderr ?? ''}`, secrets);
    if (res.status !== 0) throw new Error(`supabase db query failed:\n${output}`);
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Set once the SQL carrying the secret has been handed to the CLI. */
let secretSent = false;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--remove')) {
    query(REMOVE_SQL);
    console.log(`Removed every ${JOB_PREFIX}* schedule and the Vault secrets ${VAULT_NAMES.join(' and ')}.`);
    return;
  }

  const url = projectUrlFrom(readFileSync(resolve(ROOT, '.env.local'), 'utf8'));
  if (url instanceof Error) throw url;
  const secret = cronSecretFrom(readFileSync(resolve(ROOT, 'supabase/functions/.env'), 'utf8'));
  if (secret instanceof Error) throw secret;

  secretSent = true;
  query(vaultSql({ url, secret }), [secret]);
  console.log('Vault: project_url and cron_shared_secret stored.');

  const schedules = readFileSync(SCHEDULES, 'utf8');
  query(schedules, [secret]);
  const wanted = scheduleNames(schedules).sort();
  const listed = (readMarker(query(LISTED_SQL), 'oc-listed') ?? '').split(',').filter(Boolean);
  const missing = wanted.filter((name) => !listed.includes(name));
  if (missing.length) throw new Error(`Not scheduled after applying supabase/schedules.sql: ${missing.join(', ')}`);
  console.log(`Scheduled: ${wanted.join(', ')}.`);

  if (argv.includes('--no-wait')) return;
  const requestId = readMarker(query(TEST_TICK_SQL, [secret]), 'oc-req');
  if (!requestId || !/^\d+$/.test(requestId)) throw new Error('Could not fire a test tick (net.http_post gave no request id).');
  console.log(`Fired a test tick (request ${requestId}); waiting up to ${RESPONSE_WAIT_MS / 1000} seconds for job-runner to answer...`);
  const status = await waitForResponse(() => readMarker(query(responseSql(requestId)), 'oc-resp') ?? 'pending');
  if (status === 'failed') {
    const detail = query(`SELECT timed_out, error_msg FROM net._http_response WHERE id = ${requestId};`, [secret]);
    throw new Error(`The test tick never reached job-runner:\n${detail}`);
  }
  if (status !== '200') {
    throw new Error(
      `The job-runner test tick answered ${status ?? `nothing within ${RESPONSE_WAIT_MS / 1000} seconds`} (expected 200). Check that job-runner is deployed with ` +
        'verify_jwt off and that its CRON_SHARED_SECRET matches supabase/functions/.env (npx supabase secrets set --env-file supabase/functions/.env), then run this again.',
    );
  }
  console.log('The tick reached job-runner (200). Schedules are running.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(failureMessage(err, secretSent));
    process.exitCode = 1;
  });
}
