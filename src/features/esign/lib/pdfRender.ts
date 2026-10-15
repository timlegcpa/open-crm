import { getDocumentWatchdogged, type PDFDocumentProxy } from '@/lib/pdfjs';

/**
 * PDF pages drawn onto canvases through THE pdf.js entry point (`@/lib/pdfjs`), for the
 * page thumbnails, the field placer and the signer's review. Load it from page chunks
 * only: pdf.js is large.
 */

export interface RenderedPage {
  /** The canvas's pixel size as drawn. */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** The page's own size in PDF points (scale 1). */
  pageWidthPt: number;
  pageHeightPt: number;
}

export interface OpenedPdf {
  /** Resolves to the page count once the document has loaded. */
  ready: Promise<number>;
  /** Draw page `pageIndex` (0-based, as the tables store it) at `targetWidth` pixels. */
  renderPage: (pageIndex: number, targetWidth: number, canvas: HTMLCanvasElement) => Promise<RenderedPage>;
  /** Tear down the worker task: on unmount, or when the source changes. */
  destroy: () => void;
}

/**
 * Open `src`: `{ url }` for a signed link, `{ data }` for bytes. pdf.js TRANSFERS `data` to
 * its worker, which detaches the buffer on this side: pass a copy if the bytes are needed
 * afterwards (a download of the same file, say).
 *
 * The decode watchdog is disarmed only once every page asked for so far has been DRAWN:
 * the expensive decode happens inside render(), so disarming at load would leave a stuck
 * decoder unbounded.
 */
export function openPdf(src: { url: string } | { data: Uint8Array }): OpenedPdf {
  const loaded = getDocumentWatchdogged(src);
  let inFlight = 0;
  let destroyed = false;
  const settle = () => {
    inFlight -= 1;
    if (inFlight === 0) loaded.done();
  };
  const doc: Promise<PDFDocumentProxy> = loaded.promise;
  const ready = doc.then((pdf) => pdf.numPages);
  ready.catch(() => undefined);

  const renderPage = async (pageIndex: number, targetWidth: number, canvas: HTMLCanvasElement): Promise<RenderedPage> => {
    inFlight += 1;
    try {
      const pdf = await doc;
      const page = await pdf.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: targetWidth / base.width });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot draw the page.');
      const widthPx = Math.floor(viewport.width);
      const heightPx = Math.floor(viewport.height);
      canvas.width = widthPx;
      canvas.height = heightPx;
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      if (destroyed) throw new Error('cancelled');
      return { canvasWidthPx: widthPx, canvasHeightPx: heightPx, pageWidthPt: base.width, pageHeightPt: base.height };
    } finally {
      settle();
    }
  };

  return {
    ready,
    renderPage,
    destroy: () => {
      destroyed = true;
      void loaded.task.destroy().catch(() => undefined);
    },
  };
}
