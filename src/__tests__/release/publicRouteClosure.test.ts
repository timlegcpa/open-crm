/**
 * Public routes never load supabase-js, proven from the build manifest
 * (dist/.vite/manifest.json, written because vite.config.js sets `build.manifest`).
 *
 * A public route (signing, document verification, unsubscribe, start links, invitations,
 * forgot and reset password) renders with no session. Before its page can run, the browser
 * loads the entry chunk, the page's lazy chunk and everything either imports statically:
 * none of that may be supabase-js, the Supabase client module, the auth provider or the
 * signed-in app. Public pages reach the server through '@/lib/publicEdge' (plain fetch).
 *
 * Sign-in is NOT a public route. Every URL that is not one falls through to the `*` route in
 * App.tsx, which lazy-loads AuthenticatedApp: the sign-in form, the second factor and the
 * gate. That is the one place supabase-js loads before a session exists, because it is what
 * creates the session. The positive control below proves the detector sees it there. Two
 * public pages (an invitation, a start link) end by signing in the account the visitor just
 * created; they lazy-load the client at that step and are listed in SIGN_IN_HANDOFF.
 *
 * Routes come from the registry, not from a list in this file: every feature manifest's
 * `publicRoutes` is read from source (to find each page's module) and checked against the
 * registry's runtime list, so a new public route is covered the day it is registered, and a
 * route registered in a shape this parser cannot follow fails here instead of slipping by.
 *
 * Complements bundleBoundary.test.ts (which scans chunk files named public-*) and
 * publicRoutes.test.tsx (which proves the source graph at runtime).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicRoutes } from '@/features/registry';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');
const FEATURES = path.join(ROOT, 'src', 'features');
const hasDist = existsSync(DIST);
const built = existsSync(MANIFEST);

/** Source modules that hold or wrap the Supabase client and must stay behind sign-in. */
const SESSION_MODULES = ['src/lib/supabase.ts', 'src/lib/auth.tsx', 'src/AuthenticatedApp.tsx'];
/**
 * Public pages that end by signing the visitor in. Each lazy-loads the Supabase client
 * module (and supabase-js with it) inside its sign-in step, which runs only after the
 * visitor has just created their account with the token from their link: authentication
 * itself, never before it. Nothing else of the session code may be reachable from them.
 */
const SIGN_IN_HANDOFF: Record<string, string> = {
  'src/features/portal/public/InvitePage.tsx': 'signs the new client in after they set their password',
  'src/features/requests/public/StartPage.tsx': 'signs the new client in after they create their account',
};
/** A string only supabase-js carries, in case its code is merged into an unexpected chunk. */
const SUPABASE_SIGNATURE = 'GoTrueClient';

interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

interface ParsedRoute {
  feature: string;
  path: string;
  /** The page's module as a manifest key, e.g. src/features/esign/public/SignPage.tsx. */
  module: string;
}

/** Each feature manifest's public routes, mapped to the module its lazy page imports. */
function parsePublicRoutes(): { routes: ParsedRoute[]; problems: string[] } {
  const routes: ParsedRoute[] = [];
  const problems: string[] = [];
  for (const feature of readdirSync(FEATURES)) {
    const file = path.join(FEATURES, feature, 'manifest.tsx');
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const block = /publicRoutes:\s*\[([\s\S]*?)\]\s*,?\s*\n/.exec(source)?.[1];
    if (block === undefined) {
      if (/publicRoutes/.test(source)) problems.push(`${feature}: publicRoutes is declared in a shape this test cannot read`);
      continue;
    }
    const lazy = new Map(
      [...source.matchAll(/const (\w+) = lazyNamed\(\(\) => import\('([^']+)'\)/g)].map((m) => [m[1], m[2]] as const),
    );
    const entries = [...block.matchAll(/\{\s*path:\s*'([^']+)',\s*element:\s*<(\w+)\s*\/>\s*\}/g)];
    const declared = (block.match(/\bpath:/g) ?? []).length;
    if (entries.length !== declared) problems.push(`${feature}: ${declared - entries.length} public route(s) are not { path, element: <LazyPage /> }`);
    for (const [, routePath, component] of entries) {
      const spec = lazy.get(component);
      if (!spec) {
        problems.push(`${feature}: /${routePath} renders ${component}, which is not a lazyNamed page`);
        continue;
      }
      const base = path.posix.join('src/features', feature, spec);
      const module = [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`].find((m) => existsSync(path.join(ROOT, m)));
      if (!module) problems.push(`${feature}: cannot resolve ${spec}`);
      else routes.push({ feature, path: routePath, module });
    }
  }
  return { routes, problems };
}

describe('the public routes this test covers', () => {
  it('are exactly the registry public routes, each a lazy page module', () => {
    const { routes, problems } = parsePublicRoutes();
    expect(problems).toEqual([]);
    expect(routes.map((r) => r.path).sort()).toEqual(publicRoutes.map((r) => r.path ?? '').sort());
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });
});

// Without a build there is nothing to measure: locally, with no dist/ at all, the suite is
// skipped and its title says why. On CI (which builds first) it always runs, and wherever
// dist/ exists a missing manifest is a failed build, never a reason to skip.
const SUITE = built
  ? 'public route closure (after npm run build)'
  : hasDist
    ? 'public route closure (dist/ has no manifest: the build is broken)'
    : 'public route closure (no dist/: run npm run build, then npm test)';

describe.runIf(hasDist || Boolean(process.env.CI))(SUITE, () => {
  it('the build emitted a manifest', () => {
    expect(built, 'build did not emit a manifest (dist/.vite/manifest.json)').toBe(true);
  });

  // On CI with no build this stays empty and the first test fails, naming the missing entry.
  const manifest: Record<string, ManifestChunk> = built ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const entry = Object.keys(manifest).find((k) => manifest[k].isEntry) ?? '';
  const { routes } = parsePublicRoutes();

  const content = new Map<string, string>();
  const read = (key: string): string => {
    const file = manifest[key].file;
    if (!content.has(file)) content.set(file, readFileSync(path.join(DIST, file), 'utf8'));
    return content.get(file)!;
  };

  /** Chunks reachable from `start` by static imports: what must load before `start` runs. */
  function walk(start: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(manifest[next].imports ?? []));
    }
    return seen;
  }

  /**
   * Everything a public page could ever load, its lazy children included. Lazy imports are
   * not followed out of the entry's own chunks (those are the router's other routes, the
   * sign-in path among them), and a sign-in hand-off listed in SIGN_IN_HANDOFF is not
   * followed out of its page. Returns the chunks and the hand-off edges it skipped.
   */
  function reachable(module: string): { chunks: string[]; handoffs: string[] } {
    const fromEntry = walk([entry]);
    const seen = new Set<string>();
    const handoffs: string[] = [];
    const queue = [module];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(manifest[next].imports ?? []));
      if (fromEntry.has(next)) continue;
      for (const lazy of manifest[next].dynamicImports ?? []) {
        if (module in SIGN_IN_HANDOFF && manifest[lazy].name === 'supabase') handoffs.push(lazy);
        else queue.push(lazy);
      }
    }
    return { chunks: [...seen].filter((k) => !fromEntry.has(k)), handoffs };
  }

  /** What in these chunks belongs behind sign-in: supabase-js or the modules that wrap it. */
  function sessionCode(chunks: Iterable<string>): string[] {
    return [...chunks]
      .filter((k) => manifest[k].file.endsWith('.js'))
      .filter(
        (k) =>
          manifest[k].name === 'vendor-supabase' ||
          SESSION_MODULES.includes(manifest[k].src ?? '') ||
          read(k).includes(SUPABASE_SIGNATURE),
      )
      .map((k) => manifest[k].file);
  }

  it('finds the entry, and supabase-js in its own chunk', () => {
    expect(entry).not.toBe('');
    const vendor = Object.keys(manifest).filter((k) => manifest[k].name === 'vendor-supabase');
    expect(vendor).toHaveLength(1);
    expect(read(vendor[0])).toContain(SUPABASE_SIGNATURE);
  });

  it('control: the sign-in path (AuthenticatedApp) does load supabase-js', () => {
    expect(manifest['src/AuthenticatedApp.tsx']?.isDynamicEntry).toBe(true);
    const loaded = walk([entry, 'src/AuthenticatedApp.tsx']);
    expect(sessionCode(loaded).some((f) => f.includes('vendor-supabase-'))).toBe(true);
  });

  it('the entry alone loads no session code', () => {
    expect(sessionCode(walk([entry]))).toEqual([]);
  });

  it.each(routes.map((r) => [r.path, r.module] as const))('/%s (%s) loads no session code before sign-in', (_routePath, module) => {
    const chunk = manifest[module];
    // A page folded into the entry would be eager for every visitor: a finding of its own.
    expect(chunk?.isDynamicEntry, `${module} is not its own lazy chunk`).toBe(true);
    const loaded = walk([entry, module]);
    expect([...loaded].some((k) => manifest[k].name === 'vendor-react')).toBe(true);
    expect(sessionCode(loaded)).toEqual([]);
  });

  it.each(routes.map((r) => [r.path, r.module] as const))('/%s (%s) cannot lazy-load session code either', (_routePath, module) => {
    const { chunks, handoffs } = reachable(module);
    expect(sessionCode(chunks)).toEqual([]);
    // A listed hand-off that no longer happens is a stale exemption: remove it from the list.
    expect(handoffs.length > 0, `${module}: SIGN_IN_HANDOFF entry without a sign-in import`).toBe(module in SIGN_IN_HANDOFF);
  });
});
