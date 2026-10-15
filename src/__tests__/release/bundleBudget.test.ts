// @vitest-environment node
/**
 * Bundle size budget, read from the BUILD OUTPUT (`npm run build` writes dist/ and
 * dist/.vite/manifest.json; CI builds before it tests). Locally, with no dist/, the suite
 * is skipped; on CI a missing build fails it.
 *
 * Sizes are gzip at zlib's default level, in KiB (1 KiB = 1024 bytes). Each budget sits
 * about 15% above what the build measured when it was set (the number in the comment), so
 * ordinary growth passes and a new heavy import does not. Raise a budget only with the
 * reason in the commit, never to make a red build green.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', '..', '..', 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');
const built = existsSync(MANIFEST);

/** The entry file every visitor downloads first (measured 18.4 KiB). */
const ENTRY_FILE_KIB = 21;
/** The entry file plus every chunk it statically imports: the first paint's JavaScript (measured 93.6 KiB). */
const ENTRY_CLOSURE_KIB = 108;
/** Any single chunk (largest measured: pdf-lib, 170.9 KiB, loaded only when a PDF is written). */
const ANY_CHUNK_KIB = 197;
/**
 * pdf.js belongs only to the screens that render PDFs (measured 3: the document annotator,
 * the signer's review and the envelope composer). When a small shared
 * module lands in the pdf.js chunk, every screen that needs it loads all of pdf.js, and this
 * count jumps to dozens while no single chunk grows.
 */
const MAX_PDFJS_ROUTES = 4;

interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

// Without a build there is nothing to measure: locally the suite is skipped and its title
// says why; on CI (which builds first) a missing build fails it instead.
const SUITE = built ? 'bundle size budget (after npm run build)' : 'bundle size budget (no dist/: run npm run build, then npm test)';

describe.runIf(built || Boolean(process.env.CI))(SUITE, () => {
  // On CI with no build this stays empty and the first test fails, naming the missing entry.
  const manifest: Record<string, ManifestChunk> = built ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const sizes = new Map<string, number>();
  const kib = (key: string): number => {
    const file = manifest[key].file;
    if (!sizes.has(file)) sizes.set(file, gzipSync(readFileSync(path.join(DIST, file))).length / 1024);
    return sizes.get(file)!;
  };
  const closure = (key: string): string[] => {
    const seen = new Set<string>();
    const queue = [key];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(manifest[next].imports ?? []));
    }
    return [...seen];
  };
  const jsKeys = Object.keys(manifest).filter((k) => manifest[k].file.endsWith('.js'));
  const entry = jsKeys.find((k) => manifest[k].isEntry) ?? '';

  it('finds the entry and the chunks', () => {
    expect(entry).not.toBe('');
    expect(jsKeys.length).toBeGreaterThan(50);
  });

  it(`the entry file is at most ${ENTRY_FILE_KIB} KiB gzip`, () => {
    expect(kib(entry), manifest[entry].file).toBeLessThanOrEqual(ENTRY_FILE_KIB);
  });

  it(`the entry and its static imports are at most ${ENTRY_CLOSURE_KIB} KiB gzip`, () => {
    const loaded = closure(entry);
    // The import walk works: React is a static dependency of the entry.
    expect(loaded.some((k) => manifest[k].name === 'vendor-react')).toBe(true);
    const total = loaded.reduce((sum, k) => sum + kib(k), 0);
    expect(total, loaded.map((k) => `${manifest[k].file} ${kib(k).toFixed(1)}`).join('\n')).toBeLessThanOrEqual(ENTRY_CLOSURE_KIB);
  });

  it(`no chunk is over ${ANY_CHUNK_KIB} KiB gzip`, () => {
    const over = jsKeys.filter((k) => kib(k) > ANY_CHUNK_KIB).map((k) => `${manifest[k].file} ${kib(k).toFixed(1)} KiB`);
    expect(over).toEqual([]);
  });

  it(`pdf.js loads with at most ${MAX_PDFJS_ROUTES} lazy screens`, () => {
    const pdfjs = jsKeys.filter((k) => manifest[k].name === 'vendor-pdfjs');
    expect(pdfjs).toHaveLength(1);
    const withPdfjs = jsKeys.filter((k) => manifest[k].isDynamicEntry && closure(k).includes(pdfjs[0]));
    // The scan works: the signer's PDF review cannot render without it.
    expect(withPdfjs).toContain('src/features/esign/public/signer/PdfReview.tsx');
    expect(withPdfjs.length, withPdfjs.join('\n')).toBeLessThanOrEqual(MAX_PDFJS_ROUTES);
  });
});
