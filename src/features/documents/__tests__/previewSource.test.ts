import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPreviewBytes, readPreviewText } from '../lib/previewSource';

/**
 * A production CSP usually leaves `blob:` out of `connect-src`, so
 * `fetch(URL.createObjectURL(blob))` is blocked LIVE ONLY: the dev server sends
 * no CSP and jsdom enforces none. That once shipped a docx preview that worked
 * everywhere but production.
 *
 * So the naive test ("the renderer renders given a URL") passes identically
 * before and after the fix and asserts nothing. The load-bearing assertion is
 * that the network is never touched when the bytes are already in hand.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readPreviewBytes / readPreviewText', () => {
  it('reads the Blob without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });

    await expect(readPreviewText('blob:https://app.example.com/abc', blob)).resolves.toBe('a,b\n1,2');
    const bytes = await readPreviewBytes('blob:https://app.example.com/abc', blob);
    expect(new TextDecoder().decode(bytes)).toBe('a,b\n1,2');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to fetch when there is no Blob (redirect mode signed URL)', async () => {
    const fetchSpy = vi.fn(async () => new Response('x,y\n3,4'));
    vi.stubGlobal('fetch', fetchSpy);

    const url = 'https://project.example.com/storage/v1/object/sign/doc';
    await expect(readPreviewText(url)).resolves.toBe('x,y\n3,4');

    expect(fetchSpy).toHaveBeenCalledWith(url);
  });

  /**
   * An expired or forbidden signed URL is not a network failure: it is a 403
   * carrying an XML error body. Unchecked, that body IS the document as far as
   * the renderer is concerned: `CsvRenderer` parses it into a table of nonsense
   * rows and shows a plausible-looking file. Both helpers must throw instead.
   */
  it.each([
    ['403 with an XML error body', 403, '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'],
    ['400 with a JSON error body', 400, '{"error":"Object not found"}'],
  ])('throws on a non-ok response (%s)', async (_label, status, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

    const url = 'https://project.example.com/storage/v1/object/sign/doc';
    await expect(readPreviewText(url)).rejects.toThrow('Preview failed');
    await expect(readPreviewBytes(url)).rejects.toThrow('Preview failed');
  });
});

/**
 * The helper above only helps where it is used. These three read sites are
 * the complete set that ever fetched a preview's own blob: URL: DocxRenderer,
 * CsvRenderer, and the TextPreview inlined in PreviewSurface. The owner app and
 * the portal share this one viewer, so assert against the shipped files rather than
 * trusting the sweep was complete.
 */
const READ_SITES = [
  'viewer/renderers/DocxRenderer.tsx',
  'viewer/renderers/CsvRenderer.tsx',
  'viewer/PreviewSurface.tsx',
];

describe('preview renderers never fetch their own blob: URL', () => {
  it.each(READ_SITES)('%s reads through previewSource', (relPath) => {
    const source = readFileSync(resolve(__dirname, '..', relPath), 'utf8');

    expect(source).toMatch(/from '(\.\.\/)+lib\/previewSource'/);
    expect(source).not.toMatch(/fetch\(\s*url\s*\)/);
  });
});

/**
 * The two assertions above are necessary and NOT sufficient, which was proved by
 * mutation: delete `blob={preview.blob}` from the renderer tags in
 * `PreviewSurface.tsx` and they stay green. The renderer still
 * imports `previewSource` and still contains no literal `fetch(url)`: it calls
 * `readPreviewText(url, blob)` with `blob` undefined, so the fetch happens one
 * level down, against the `blob:` URL, and production CSP blocks it. That is the
 * whole original bug, reintroduced with the guard passing.
 *
 * So assert the wiring too: every renderer that accepts a Blob must be HANDED
 * one. `XlsxRenderer` is deliberately absent: it is a stub that never reads the
 * bytes, so it takes no `blob` prop and must not be required to.
 */
const SURFACES = [
  'viewer/PreviewSurface.tsx',
];
const BLOB_CONSUMERS = ['DocxRenderer', 'CsvRenderer', 'TextPreview'];

describe('PreviewSurface hands the in-memory Blob to every renderer that reads bytes', () => {
  it.each(SURFACES)('%s passes blob= to each consumer', (relPath) => {
    const source = readFileSync(resolve(__dirname, '..', relPath), 'utf8');

    for (const tag of BLOB_CONSUMERS) {
      const rendered = new RegExp(`<${tag}\\b[^>]*/>`, 'g');
      const tags = source.match(rendered) ?? [];
      expect(tags.length, `${relPath} renders no <${tag}>`).toBeGreaterThan(0);
      for (const t of tags) {
        // The loaded Blob itself, not just an attribute: `blob={undefined}`
        // satisfies a presence check and still fetches the blob: URL.
        expect(t, `<${tag}> in ${relPath} must receive blob={preview.blob}`).toMatch(/\bblob=\{preview\.blob\}/);
      }
    }
  });
});
