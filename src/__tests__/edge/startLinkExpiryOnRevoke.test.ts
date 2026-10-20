// @vitest-environment node
/**
 * Every path that takes portal access away also expires the contact's pending start links.
 *
 * A start link (`pending_signup_requests`, redeemed by accept-start-link) creates a fresh
 * active sign-in. A revoke that leaves the contact's links pending reads as if whoever holds
 * an old link email could undo it. The source this was ported from found the same gap on
 * three separate revoke paths, one at a time, so the rule is a test here.
 *
 * revoke-portal-access expires them inside deactivate_portal_account (0016), in the revoke's
 * own transaction; revoke-portal-access.test.ts pins that against PGlite. delete-contact
 * expires them from the handler before the release; deleteContact.test.ts pins the order,
 * the await and when it runs. What that cannot reach is the Deno wiring in index.ts, so
 * this pins it at the text level: the query is awaited (a supabase-js builder is a lazy
 * thenable, so the same chain without `await` never sends a request) and its error is
 * thrown, not dropped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const read = (fn: string, file: string) => readFileSync(resolve(REPO, 'supabase/functions', fn, file), 'utf8');

const WIRING =
  /async expireStartLinks\(contactId\) \{\s*const \{ error \} = await server\s*\.from\('pending_signup_requests'\)\s*\.update\(\{ status: 'expired' \}\)\s*\.eq\('contact_id', contactId\)\s*\.eq\('status', 'pending'\);\s*if \(error\) throw error;/;

describe('delete-contact expires the pending start links', () => {
  it('wires the expiry to the database', () => {
    expect(read('delete-contact', 'index.ts')).toMatch(WIRING);
  });

  it('awaits the expiry in the handler', () => {
    expect(read('delete-contact', 'handler.ts')).toMatch(/await deps\.expireStartLinks\(/);
  });
});
