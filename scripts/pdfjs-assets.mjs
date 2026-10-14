// Serves (dev) and emits (build) the pdf.js image-decoder assets at /pdfjs/<version>/.
//
// pdf.js decodes JPEG 2000 and JBIG2 (ordinary scanner output) through WebAssembly that it
// fetches from `wasmUrl`, and colour-manages through ICC profiles from `iccUrl`. If those
// URLs 404, an affected page paints BLANK with only a console warning. `src/lib/pdfjs.ts`
// points pdf.js at the paths built by `src/lib/pdfjsAssetPaths.ts`; this plugin makes those
// paths real, straight from the installed pdfjs-dist, so there is no committed copy to drift.
// `src/lib/__tests__/pdfjsAssets.test.ts` pins the two together.
//
// The version is in the path so an upgrade moves code and assets to a new URL together: a
// cached browser can never pair a new bundle with the previous release's decoders.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PDFJS_DIR = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));

export const PDFJS_ASSET_DIRS = ['wasm', 'iccs'];

// quickjs-eval.* is pdf.js's PDF-JavaScript interpreter. Scripting is never enabled, so
// shipping it would only add attack surface. Deliberately not served.
const EXCLUDE = /^quickjs-eval\./;

const CONTENT_TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.icc': 'application/vnd.iccprofile',
};

/** The installed pdfjs-dist version: the same string `pdfjs.version` returns at runtime. */
export function pdfjsVersion() {
  return JSON.parse(readFileSync(join(PDFJS_DIR, 'package.json'), 'utf8')).version;
}

/** Every served asset as { dir, name }, sorted, the script engine excluded. */
export function collectPdfjsAssets() {
  return PDFJS_ASSET_DIRS.flatMap((dir) =>
    readdirSync(join(PDFJS_DIR, dir))
      .sort()
      .filter((name) => !EXCLUDE.test(name))
      .map((name) => ({ dir, name })),
  );
}

/** The served path of one asset, without the leading slash: `pdfjs/<version>/<dir>/<name>`. */
export function pdfjsAssetFileName(version, dir, name) {
  return `pdfjs/${version}/${dir}/${name}`;
}

export function pdfjsAssetSource(dir, name) {
  return readFileSync(join(PDFJS_DIR, dir, name));
}

function contentType(name) {
  const dot = name.lastIndexOf('.');
  return CONTENT_TYPES[dot === -1 ? '' : name.slice(dot)] ?? 'text/plain; charset=utf-8';
}

/** The Vite plugin. */
export function pdfjsAssets() {
  return {
    name: 'open-crm:pdfjs-assets',
    configureServer(server) {
      const version = pdfjsVersion();
      const byPath = new Map(collectPdfjsAssets().map((a) => [`/${pdfjsAssetFileName(version, a.dir, a.name)}`, a]));
      server.middlewares.use((req, res, next) => {
        const asset = byPath.get((req.url ?? '').split('?')[0]);
        if (!asset) return next();
        res.setHeader('Content-Type', contentType(asset.name));
        res.setHeader('Cache-Control', 'no-cache');
        res.end(pdfjsAssetSource(asset.dir, asset.name));
      });
    },
    generateBundle() {
      const version = pdfjsVersion();
      for (const { dir, name } of collectPdfjsAssets()) {
        this.emitFile({ type: 'asset', fileName: pdfjsAssetFileName(version, dir, name), source: pdfjsAssetSource(dir, name) });
      }
    },
  };
}
