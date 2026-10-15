import { getDocumentWatchdogged, type PDFDocumentProxy } from '@/lib/pdfjs';
import type { PageGeometry } from './coords';

/**
 * PDF pages drawn onto canvases through THE pdf.js entry point (`@/lib/pdfjs`), for the
 * page thumbnails, the field placer and the signer's review. Load it from page chunks
 * only: pdf.js is large.
 */

export interface RenderedPage {
  /** The canvas's pixel size as drawn. */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** The viewport's viewBox (CropBox), rotation and scale: the canvas <-> user-space mapping. */
  geometry: PageGeometry;
}

export interface OpenedPdf {
  /** Resolves to the page count once the document has loaded. */
  ready: Promise<number>;
  /**
   * Draw page `pageIndex` (0-based, as the tables store it) at `targetWidth` pixels.
   * Aborting `signal` cancels the draw; the promise then rejects with a RenderCancelled.
   */
  renderPage: (pageIndex: number, targetWidth: number, canvas: HTMLCanvasElement, signal?: AbortSignal) => Promise<RenderedPage>;
  /** Tear down the worker task: on unmount, or when the source changes. */
  destroy: () => void;
}

/** A draw that was superseded or torn down. Callers ignore it: it is not a failure. */
export class RenderCancelled extends Error {
  constructor() {
    super('Page drawing was cancelled.');
    this.name = 'RenderCancelled';
  }
}

export function isRenderCancelled(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'RenderCancelled' || name === 'RenderingCancelledException';
}

/**
 * The draw each canvas is busy with. pdf.js refuses a second render() on a canvas while one
 * is in flight ("Cannot use the same canvas during multiple render() operations"), and a
 * resize re-runs a draw on the same canvas while the first is still going. So every draw is
 * cancelled through its signal by whoever supersedes it, and the next draw waits for the
 * previous one on that canvas to settle before it touches the canvas at all. Module-wide,
 * because a caller may open a fresh document for the same canvas.
 */
const canvasBusy = new WeakMap<HTMLCanvasElement, Promise<unknown>>();

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

  const draw = async (pageIndex: number, targetWidth: number, canvas: HTMLCanvasElement, signal: AbortSignal | undefined): Promise<RenderedPage> => {
    const stopped = () => destroyed || signal?.aborted === true;
    const pdf = await doc;
    const page = await pdf.getPage(pageIndex + 1);
    // Checked again right before render(): a superseded draw never claims the canvas.
    if (stopped()) throw new RenderCancelled();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the page.');
    const widthPx = Math.floor(viewport.width);
    const heightPx = Math.floor(viewport.height);
    canvas.width = widthPx;
    canvas.height = heightPx;
    const task = page.render({ canvasContext: context, viewport, canvas });
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
    } catch (err) {
      throw isRenderCancelled(err) ? new RenderCancelled() : err;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    if (stopped()) throw new RenderCancelled();
    const [x0, y0, x1, y1] = viewport.viewBox;
    return {
      canvasWidthPx: widthPx,
      canvasHeightPx: heightPx,
      geometry: { viewBox: [x0, y0, x1, y1], rotation: viewport.rotation, scale: viewport.scale },
    };
  };

  const renderPage = async (pageIndex: number, targetWidth: number, canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<RenderedPage> => {
    inFlight += 1;
    const previous = canvasBusy.get(canvas);
    const run = (async () => {
      if (previous) await previous.catch(() => undefined);
      if (destroyed || signal?.aborted) throw new RenderCancelled();
      return draw(pageIndex, targetWidth, canvas, signal);
    })();
    const settled = run.catch(() => undefined);
    canvasBusy.set(canvas, settled);
    try {
      return await run;
    } finally {
      if (canvasBusy.get(canvas) === settled) canvasBusy.delete(canvas);
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
