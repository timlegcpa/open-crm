// @vitest-environment node
/**
 * What a visitor to a public page downloads, read from the BUILD OUTPUT (run after
 * `npm run build`; CI does). Public pages (signing, unsubscribe, invitations...) must never
 * load supabase-js, and the entry bundle every visitor gets must carry neither supabase-js
 * nor pdf.js. publicRoutes.test.tsx proves the source graph; this proves what the bundler
 * actually emitted, which can differ: Rolldown merges small shared modules into the chunk
 * that already holds them, and one stray import can pull a vendor chunk in.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', '..', 'dist');
const ASSETS = path.join(DIST, 'assets');
const built = existsSync(path.join(DIST, 'index.html'));

/** Strings only supabase-js and pdf.js carry, in case their code lands outside their vendor chunk. */
const SUPABASE_SIGNATURES = ['GoTrueClient', 'supabase-js'];
const PDFJS_SIGNATURES = ['GlobalWorkerOptions'];

const STATIC_IMPORT = /\bimport\s*(?:[^'"`()]*?\bfrom\s*)?["'`](\.\/[^"'`]+\.js)["'`]/g;

function staticImports(file: string): string[] {
  const source = readFileSync(path.join(ASSETS, file), 'utf8');
  return [...source.matchAll(STATIC_IMPORT)].map((m) => m[1].slice(2));
}

/** A chunk and every chunk it statically imports: what the browser must load before it runs. */
function closure(file: string): string[] {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...staticImports(next));
  }
  return [...seen];
}

function carries(files: string[], signatures: string[]): string[] {
  return files.filter((f) => {
    const source = readFileSync(path.join(ASSETS, f), 'utf8');
    return signatures.some((s) => source.includes(s));
  });
}

describe.runIf(built || Boolean(process.env.CI))('bundle boundary (after npm run build)', () => {
  const html = built ? readFileSync(path.join(DIST, 'index.html'), 'utf8') : '';
  const entry = /<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? '';
  const files = built ? readdirSync(ASSETS) : [];
  const publicChunks = files.filter((f) => f.startsWith('public-') && f.endsWith('.js'));

  it('finds the entry and the public page chunks', () => {
    expect(entry).not.toBe('');
    expect(publicChunks.length).toBeGreaterThanOrEqual(1);
  });

  it('the entry bundle carries neither supabase-js nor pdf.js, nor the signed-in app', () => {
    const loaded = closure(entry);
    // The import scan works: React is a static dependency of the entry.
    expect(loaded.some((f) => f.startsWith('vendor-react-'))).toBe(true);
    expect(loaded.filter((f) => /^(vendor-supabase|vendor-pdfjs|AuthenticatedApp|OwnerApp|PortalApp)-/.test(f))).toEqual([]);
    expect(carries(loaded, SUPABASE_SIGNATURES)).toEqual([]);
    expect(carries(loaded, PDFJS_SIGNATURES)).toEqual([]);
  });

  it('no public page loads supabase-js', () => {
    for (const chunk of publicChunks) {
      const loaded = closure(chunk);
      expect(loaded.some((f) => f.startsWith('vendor-react-')), chunk).toBe(true);
      expect(loaded.filter((f) => f.startsWith('vendor-supabase-')), chunk).toEqual([]);
      expect(carries(loaded, SUPABASE_SIGNATURES), chunk).toEqual([]);
    }
  });

  it('self-hosts the Inter font', () => {
    expect(files.some((f) => /^inter-latin-wght-normal-.*\.woff2$/.test(f))).toBe(true);
  });
});
