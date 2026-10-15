// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * NOTHING deletes a `client-documents` storage object automatically, and this test is
 * what makes that true rather than merely written down.
 *
 * One object can back MORE THAN ONE `client_documents` row, and Storage is not
 * transactional with Postgres, so a delete that strands a surviving row is permanent.
 * Two routes create the sharing: e-sign filing one signed PDF to every signer over one
 * object, and `copyToShared` (api.ts) putting the source row's `storage_path` on a
 * second, shared row.
 *
 * It is a TEST because the same defect was found three separate times in the system this
 * was carried from, each in a site the previous sweep had not looked at: the
 * per-document delete, the folder purge one function below it (its RPC is scoped to ONE
 * contact and ONE section, so it can only ever delete half of a copy pair's references,
 * and RLS scopes the ROW deletes but never the Storage delete), and a "delete the
 * documents too" box on a request list. A prose rule that three sweeps walked past is
 * not a rule.
 *
 * There is no allowlist, and none may be added. If this fails, delete the ROW and leave
 * the object for the orphan report, which is manual on purpose. A "does any row still
 * point at it?" check does NOT rescue a delete: it races every concurrent copy. Even
 * encrypt-document's failed-insert path keeps its object: an insert can commit and still
 * report a failure (a lost acknowledgement), and removing the object then would leave a
 * live row over deleted content.
 */

const REPO = resolve(__dirname, '../../../..');
const ROOTS = ['src', 'supabase/functions', 'scripts'];
const EXTS = ['.ts', '.tsx', '.mjs', '.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SELF = 'src/features/documents/__tests__/clientDocumentsStorageDeleteGuard.test.ts';

/**
 * `.from(<bucket>)` then, across any whitespace or newlines, `.remove(`. The bucket is a
 * string literal or an identifier; an identifier is resolved against a
 * `const NAME = '<bucket>'` in the same file, and one that cannot be resolved is
 * reported (UNRESOLVED) rather than silently passed.
 */
const STORAGE_REMOVE = /\.from\(\s*(?:['"]([a-z0-9-]+)['"]|([A-Za-z_$][\w$]*))\s*\)\s*\.remove\(/g;
const UNRESOLVED = '<unresolved>';

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function resolveBucket(src: string, identifier: string): string {
  const m = new RegExp(`const\\s+${identifier}\\s*=\\s*['"]([a-z0-9-]+)['"]`).exec(src);
  return m ? m[1] : UNRESOLVED;
}

/** ONE scan for the whole file, bucket -> the files that call .remove() on it. */
const SITES_BY_BUCKET: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root), [])) {
      const rel = file.slice(REPO.length + 1).split('\\').join('/');
      if (rel === SELF) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(STORAGE_REMOVE)) {
        const bucket = m[1] ?? resolveBucket(src, m[2]);
        if (!map.has(bucket)) map.set(bucket, new Set());
        map.get(bucket)!.add(rel);
      }
    }
  }
  return map;
})();

function callSites(bucket: string): string[] {
  return [...(SITES_BY_BUCKET.get(bucket) ?? [])].sort();
}

describe('client-documents storage objects are never deleted automatically', () => {
  it('the scanner finds a call site in every shape it reads (so an empty result means something)', () => {
    const shapes = [
      "await storage.from('client-documents').remove([path]);",
      ['storage', '  .from(BUCKET)', '  .remove(paths)'].join('\n'),
    ];
    for (const shape of shapes) expect([...shape.matchAll(STORAGE_REMOVE)], shape).toHaveLength(1);
    expect(resolveBucket("const BUCKET = 'client-documents';", 'BUCKET')).toBe('client-documents');
  });

  it('no file calls .remove() on the bucket: not the browser, not any function', () => {
    expect(callSites('client-documents')).toEqual([]);
  });

  it('no .remove() names its bucket in a way the scanner cannot read', () => {
    expect(callSites(UNRESOLVED)).toEqual([]);
  });

  it('the browser never removes a storage object at all', () => {
    const browserSites = [...SITES_BY_BUCKET.values()].flatMap((s) => [...s]).filter((f) => f.startsWith('src/'));
    expect(browserSites).toEqual([]);
  });
});
