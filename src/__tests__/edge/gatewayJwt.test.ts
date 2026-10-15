// @vitest-environment node
// The Supabase gateway checks a user JWT before a function runs unless config.toml turns it
// off for that function. A function that authenticates itself (public, an API key, or the
// cron secret) must have it off, or its real callers (a browser report, an email link,
// another server, pg_cron) are refused at the gateway. A function that only takes a signed-in session keeps
// it on: the gateway check is a second lock, and turning it off without a reason removes it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'supabase/functions';

function functionDirs(): string[] {
  return readdirSync(ROOT).filter((d) => !d.startsWith('_') && statSync(path.join(ROOT, d)).isDirectory());
}

/** The functions whose handler declares the public, apiKey or cron mode. */
function selfAuthenticating(): string[] {
  return functionDirs()
    .filter((dir) => {
      const text = readFileSync(path.join(ROOT, dir, 'handler.ts'), 'utf8');
      return /\bauth:\s*\{\s*(public:\s*true|apiKey:)/.test(text) || /\bauth:\s*\{[^}]*\bcron:\s*\{/.test(text);
    })
    .sort();
}

/** The functions config.toml exempts from the gateway JWT check. */
function exempted(toml: string): string[] {
  return [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]\s*\r?\nverify_jwt\s*=\s*false\s*$/gm)].map((m) => m[1]).sort();
}

describe('gateway JWT check (supabase/config.toml)', () => {
  const toml = readFileSync('supabase/config.toml', 'utf8');

  it('is off for exactly the functions that authenticate their own callers', () => {
    const own = selfAuthenticating();
    // The scan finds the functions it is meant to guard.
    expect(own).toEqual(expect.arrayContaining(['csp-report', 'job-runner', 'lead-intake', 'mcp-crm']));
    expect(exempted(toml)).toEqual(own);
  });

  it('names only functions that exist, and never turns the check back on by a second entry', () => {
    const dirs = new Set(functionDirs());
    const sections = [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
    expect(sections.filter((name) => !dirs.has(name))).toEqual([]);
    expect(new Set(sections).size).toBe(sections.length);
  });
});
