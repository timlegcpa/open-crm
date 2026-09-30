#!/usr/bin/env node
// npm run dev:bootstrap [-- --email you@example.com --password '...' --org-name 'Your Firm' --yes]
//
// Run once, after the migrations are pushed to your Supabase project (see the README). It:
//   1. generates the edge-function secrets into supabase/functions/.env (only the missing ones),
//   2. writes the project's URL and anon key into .env.local (only if missing),
//   3. creates the owner account and the system actor, and writes the org_profile row.
// Every step is safe to repeat. Anything not given is asked for.
//
// The project's values come from SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY in the environment, or are asked for. The service key
// is used for this run only and is never written to disk.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import {
  ensurePrincipals,
  generateSecrets,
  mergeEnv,
  ownerProblems,
  parseArgs,
  projectProblems,
  systemActorPassword,
} from './lib/bootstrap-core.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function writeEnvFile(path, wanted, label) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const { text, added } = mergeEnv(before, wanted);
  if (added.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
  }
  console.log(added.length ? `${label}: added ${added.join(', ')}` : `${label}: already complete`);
}

/** Ask without echoing what is typed. */
async function askHidden(rl, prompt) {
  process.stdout.write(prompt);
  const write = rl._writeToOutput;
  rl._writeToOutput = () => {};
  try {
    return await rl.question('');
  } finally {
    rl._writeToOutput = write;
    process.stdout.write('\n');
  }
}

async function ask(args) {
  const out = {
    ...args,
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const labels = {
    url: 'SUPABASE_URL',
    anonKey: 'SUPABASE_ANON_KEY',
    serviceKey: 'SUPABASE_SERVICE_ROLE_KEY',
    orgName: '--org-name',
    email: '--email',
    password: '--password',
  };
  const missing = Object.keys(labels).filter((k) => !out[k]);
  if (missing.length === 0) return out;
  if (args.yes || !process.stdin.isTTY) {
    throw new Error(`Missing ${missing.map((k) => labels[k]).join(', ')}.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!out.url) out.url = (await rl.question('Project URL (Project Settings > API): ')).trim();
    if (!out.anonKey) out.anonKey = (await rl.question('Anon (publishable) key: ')).trim();
    if (!out.serviceKey) out.serviceKey = (await askHidden(rl, 'Service role (secret) key, used for this run only: ')).trim();
    if (!out.orgName) out.orgName = await rl.question('Organization name: ');
    if (!out.email) out.email = await rl.question('Owner email: ');
    if (!out.password) out.password = await askHidden(rl, 'Owner password (8+ chars, upper, lower, digit, symbol): ');
    return out;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = await ask(parseArgs(process.argv.slice(2)));
  const problems = [...projectProblems(args), ...ownerProblems(args)];
  if (problems.length) throw new Error(`Cannot bootstrap:\n  ${problems.join('\n  ')}`);

  writeEnvFile(resolve(ROOT, 'supabase/functions/.env'), generateSecrets(randomBytes), 'supabase/functions/.env');
  writeEnvFile(
    resolve(ROOT, '.env.local'),
    { VITE_SUPABASE_URL: args.url, VITE_SUPABASE_ANON_KEY: args.anonKey },
    '.env.local',
  );

  const db = createClient(args.url, args.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await ensurePrincipals(db, args, () => systemActorPassword(randomBytes));
  console.log(
    result.ownerCreated ? 'Owner created.'
      : result.ownerAdopted ? 'Existing account adopted as owner (password set).'
      : 'Owner already exists (password unchanged).',
  );
  console.log(result.systemCreated ? 'System actor created.' : 'System actor already exists.');
  console.log(result.profileCreated ? 'Organization row created.' : 'Organization row already exists.');
  console.log('\nNext: `npm run dev`, then sign in at http://localhost:5173.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
