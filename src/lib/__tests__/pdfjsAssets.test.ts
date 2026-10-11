// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPdfjsAssets, pdfjsAssetFileName, pdfjsVersion } from '../../../scripts/pdfjs-assets.mjs';
import { pdfjsAssetPaths } from '@/lib/pdfjsAssetPaths';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const version = pdfjsVersion();
const assets = collectPdfjsAssets();

describe('pdf.js decoder assets', () => {
  it('are served exactly where pdf.js is told to look', () => {
    const urls = pdfjsAssetPaths(version);
    for (const { dir, name } of assets) {
      const base = dir === 'wasm' ? urls.wasmUrl : urls.iccUrl;
      expect(`/${pdfjsAssetFileName(version, dir, name)}`).toBe(`${base}${name}`);
    }
  });

  it('include the image decoders and colour profiles, never the PDF script engine', () => {
    const names = assets.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['openjpeg.wasm', 'jbig2.wasm']));
    expect(names.some((n) => n.endsWith('.icc'))).toBe(true);
    expect(names.filter((n) => n.startsWith('quickjs-eval'))).toEqual([]);
  });

  it('pins pdfjs-dist to the exact version the paths carry', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['pdfjs-dist']).toBe(version);
  });

  // The build emits them; CI builds before it tests. Locally, without a build, this is skipped.
  const built = existsSync(path.join(ROOT, 'dist', 'index.html'));
  it.runIf(built || Boolean(process.env.CI))('are in the build output (after npm run build)', () => {
    const wasmDir = path.join(ROOT, 'dist', 'pdfjs', version, 'wasm');
    expect(existsSync(wasmDir)).toBe(true);
    expect(readdirSync(wasmDir).sort()).toEqual(assets.filter((a) => a.dir === 'wasm').map((a) => a.name).sort());
  });
});
