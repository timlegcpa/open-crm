#!/usr/bin/env node
// npm run demo:seed [-- --force]
//
// Loads supabase/seed/demo.sql (fictional demo data) into the linked Supabase project, the
// same way `npm run schedules:install` reaches the database: `npx supabase db query
// --linked -f <file>` (the Management API; no Docker, no database password). Run it after
// `supabase link`, `db push` and `npm run dev:bootstrap`.
//
// The file guards itself, so pasting it into the SQL editor is just as safe: it refuses a
// project with no owner yet, and one that already holds contacts of its own. --force
// prepends the one line that lifts the second refusal. A second run changes nothing.
//
// If the CLI cannot reach the project (not linked, not logged in), this prints how to
// load the file through the SQL editor instead.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query } from './install-schedules.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const SEED_FILE = 'supabase/seed/demo.sql';

/** The statement that lets the seed load beside the project's own contacts. */
export function forceSql() {
  return "SELECT set_config('open_crm.demo_seed_force', 'on', false);";
}

/** The seed with the force line in front of it. */
export function withForce(sql) {
  return `${forceSql()}\n${sql}`;
}

export const EDITOR_HELP = [
  'To load the demo data without the CLI, open your project in the Supabase dashboard,',
  `go to the SQL editor, paste the whole of ${SEED_FILE} and run it.`,
  `To load it beside contacts you already have, put this line first: ${forceSql()}`,
].join('\n');

/** The seed's own refusal message in the CLI's output, or null when it failed for another reason. */
export function refusalIn(output) {
  const m = /demo seed: [^\r\n"]*/.exec(String(output));
  return m ? m[0].trim() : null;
}

function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => a !== '--force');
  if (unknown.length) throw new Error(`Unknown option ${unknown[0]}. Known: --force`);

  const seed = readFileSync(resolve(ROOT, SEED_FILE), 'utf8');
  const sql = argv.includes('--force') ? withForce(seed) : seed;

  try {
    query(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The seed's own refusals (no owner yet, contacts of the project's own) are answers,
    // not connection trouble: say them alone, never "paste it into the SQL editor".
    const refusal = refusalIn(message);
    if (refusal) throw new Error(refusal);
    throw new Error(`${message.trim()}\n\n${EDITOR_HELP}`);
  }
  console.log('Demo data loaded (or already there). Open Contacts to see it.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
