import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFJS_MAX_IMAGE_SIZE, pdfjsAssetPaths } from './pdfjsAssetPaths';

/**
 * THE way into pdf.js. Import from here, never from `pdfjs-dist` directly:
 *
 *   import { pdfjs, getDocumentWatchdogged } from '@/lib/pdfjs';
 *
 * Importing this module configures the worker once (the worker file is bundled by Vite
 * through `?url`, so it is served from this origin and matches the API version exactly).
 * Every `getDocument()` must carry PDFJS_DOC_OPTIONS, which `getDocumentWatchdogged` does
 * for you. Load this module lazily (from a page chunk, never a manifest): pdf.js is large.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export { pdfjs };
export type { PDFDocumentLoadingTask, PDFDocumentProxy };
export { PDFJS_MAX_IMAGE_SIZE };

/**
 * Spread into every `getDocument()` call.
 *
 * - `wasmUrl` / `iccUrl`: pdf.js decodes JPEG 2000 and JBIG2 (ordinary scanner output)
 *   through WebAssembly fetched from here, and colour-manages through ICC profiles. Unset,
 *   an affected page paints BLANK with only a console warning. The files are served and
 *   emitted by `scripts/pdfjs-assets.mjs`.
 * - `maxImageSize`: see PDFJS_MAX_IMAGE_SIZE.
 * - `isEvalSupported: false`: these are files clients upload; pdf.js never needs `eval`
 *   to render them, and the page's script policy should not have to allow it.
 */
export const PDFJS_DOC_OPTIONS = {
  ...pdfjsAssetPaths(pdfjs.version),
  maxImageSize: PDFJS_MAX_IMAGE_SIZE,
  isEvalSupported: false,
} as const;

/**
 * How long a document may take to load AND render before its worker is terminated. The
 * image-size cap is checked against the image dictionary, but the decoder sees the
 * codestream's own dimensions, so a crafted file can still wedge it; destroying the task is
 * the only thing that stops a stuck decoder. No real document comes near this.
 */
export const PDFJS_PARSE_TIMEOUT_MS = 60_000;

/**
 * `getDocument()` with the options above and a decode watchdog attached.
 *
 * Call `done()` once the page is RENDERED (in a `finally`), not once the document loaded:
 * the expensive decode happens inside `page.render()`. Forgetting `done()` costs a task
 * destroyed 60 s after a good render, which is loud; the reverse would be a silent hang.
 * On timeout the task is destroyed, which rejects the load and any render in flight, so a
 * caller's existing `catch` covers it. Tear down with `task.destroy()` on unmount.
 */
export function getDocumentWatchdogged(
  src: Record<string, unknown>,
): { task: PDFDocumentLoadingTask; promise: Promise<PDFDocumentProxy>; done: () => void } {
  const task = pdfjs.getDocument({ ...PDFJS_DOC_OPTIONS, ...src } as Parameters<typeof pdfjs.getDocument>[0]);
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    void task.destroy().catch(() => undefined);
  }, PDFJS_PARSE_TIMEOUT_MS);
  const done = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const promise = task.promise;
  // A caller that unmounts before awaiting must not turn the destroy into an unhandled rejection.
  promise.catch(() => undefined);
  return { task, promise, done };
}
