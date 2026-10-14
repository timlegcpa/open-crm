/**
 * Where the pdf.js image-decoder assets are served, as a pure function of the pdf.js version.
 *
 * Split from `pdfjs.ts` for one reason: that module imports `pdfjs-dist`, which touches DOM
 * globals at module scope, so a node test cannot import it. The URL the app requests and the
 * path `scripts/pdfjs-assets.mjs` serves and emits must agree (a mismatch 404s every decoder
 * fetch and paints affected pages BLANK, with only a console warning), so the construction
 * has to be reachable from `src/lib/__tests__/pdfjsAssets.test.ts`.
 *
 * Trailing slashes are significant: pdf.js appends the file name directly to these strings.
 * The version segment moves code and assets to a new URL together on a pdfjs-dist upgrade,
 * so a cached browser never pairs a new bundle with an old decoder.
 */
export const pdfjsAssetPaths = (version: string) => ({
  wasmUrl: `/pdfjs/${version}/wasm/`,
  iccUrl: `/pdfjs/${version}/iccs/`,
});

/**
 * pdf.js `maxImageSize`, in pixels (64 MP). Uploaded PDFs reach the JPEG 2000 and JBIG2
 * decoders, and pdf.js defaults this to unbounded, so a small file could declare an image
 * that exhausts the tab. 64 MP is far above any real scan (600 dpi legal colour is ~43 MP).
 * pdf.js SKIPS an image over the limit, so that one image paints blank.
 */
export const PDFJS_MAX_IMAGE_SIZE = 64_000_000;
