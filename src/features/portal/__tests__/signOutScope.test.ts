// @vitest-environment node
// Every sign-out in the app is scoped: 'local' (this browser) or 'others' (after a password
// change). A bare or global sign-out while viewing as client would sign the real client out
// of every device they use.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * The only call sites allowed a 'global' sign-out, each on purpose. Keyed by file (relative to
 * src, forward slashes) with how many such calls the file may carry.
 * - settings/SecuritySection.tsx: the owner's "Sign out everywhere" button in Settings, an
 *   explicit, confirmed request to end every session. Settings lives in the owner app only, so
 *   a View-as-client session (which runs the portal app) can never reach it.
 */
const GLOBAL_ALLOWED: Record<string, number> = {
  'features/settings/SecuritySection.tsx': 1,
};

describe('sign-out scope', () => {
  it("every auth.signOut call passes scope 'local' or 'others', except the listed global ones", () => {
    const globals: Record<string, number> = {};
    const calls: string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bsignOut\(([^)]*)\)/g)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        calls.push(rel);
        if (/^\s*\{\s*scope:\s*'global'\s*\}\s*$/.test(match[1]) && rel in GLOBAL_ALLOWED) {
          globals[rel] = (globals[rel] ?? 0) + 1;
          continue;
        }
        if (!/^\s*\{\s*scope:\s*'(local|others)'\s*\}\s*$/.test(match[1])) offenders.push(`${rel}: signOut(${match[1]})`);
      }
    }
    // The scan finds the calls it is meant to guard.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
    // Each allowed file carries exactly its listed global calls: a second one, or a stale entry, fails.
    expect(globals).toEqual(GLOBAL_ALLOWED);
  });
});
