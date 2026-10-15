import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pdfjs,
  PDFJS_DOC_OPTIONS,
  PDFJS_PARSE_TIMEOUT_MS,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from '@/lib/pdfjs';
import { documentBytes } from '../api';
import { sniffWrappableImage, wrapImageAsPdf } from '../lib/imageToPdf';

export interface PageMeta {
  /** Viewport width in PDF points at scale 1 (post-/Rotate, i.e. as displayed). */
  widthPt: number;
  /** Viewport height in PDF points at scale 1 (post-/Rotate). */
  heightPt: number;
  /** Page /Rotate value in degrees (0 | 90 | 180 | 270). */
  rotation: number;
}

/**
 * `timeout` is NOT a shade of `invalid`. Both watchdogs below fire on a
 * document that is structurally fine and simply took too long to decode: a
 * pathological JPX/JBIG2 codestream is the case they were written for: and
 * reporting that as "it may not be a valid PDF file" tells whoever uploaded it
 * to go fix a file that has nothing wrong with it.
 */
export type AnnotatorDocError = 'password' | 'invalid' | 'timeout' | 'image';

/**
 * `image`: the bytes are an image the annotator cannot wrap (over the PNG
 * pixel ceiling, a format pdf-lib cannot decode, or an image/* record whose
 * bytes are something else). The surface hands it back to the plain preview,
 * which showed these files fine before images were annotatable.
 */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46]; // %PDF
function hasPdfHeader(bytes: Uint8Array): boolean {
  // The spec allows the header anywhere in the first 1024 bytes.
  const limit = Math.min(bytes.length - PDF_HEADER.length, 1024);
  for (let i = 0; i <= limit; i++) {
    if (PDF_HEADER.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
}


interface AnnotatorDocState {
  status: 'loading' | 'ready' | 'error';
  error: AnnotatorDocError | null;
  pdf: PDFDocumentProxy | null;
  pageMetas: PageMeta[];
  /** The document an 'image' error belongs to. State resets in an effect, so
   *  for one render after a switch `error` still describes the previous doc. */
  imageErrorDocId?: string;
}

const INITIAL_STATE: AnnotatorDocState = { status: 'loading', error: null, pdf: null, pageMetas: [] };

/**
 * Fetches the document's decrypted bytes, loads them into pdfjs, and exposes
 * per-page metadata for pre-sizing page containers.
 *
 * IMPORTANT: pdfjs transfers the typed array's buffer to its worker and
 * DETACHES it: a pristine copy is taken BEFORE `getDocument` so `getBytes()`
 * (the flatten/export input) always returns usable bytes.
 */
export function useAnnotatorDoc(
  docId: string,
): AnnotatorDocState & {
  getBytes: () => Uint8Array | null;
  /** Call when a page render exceeds PDFJS_PARSE_TIMEOUT_MS: see below. */
  reportRenderStall: () => void;
  hasBytes: boolean;
} {
  const [state, setState] = useState<AnnotatorDocState>(INITIAL_STATE);
  const pristineRef = useRef<Uint8Array | null>(null);
  const proxyRef = useRef<PDFDocumentProxy | null>(null);
  // pdfjs 6 removed PDFDocumentProxy.destroy(); teardown now lives on the
  // loading task, so the task has to be held for the lifetime of the document.
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  // Monotonic load token: a stale getDocument resolve (close/re-open during
  // load) must destroy its proxy, not store it or clobber a newer load's.
  const loadTokenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const token = ++loadTokenRef.current;
    setState(INITIAL_STATE);

    // Hard ceiling on parse+metadata. maxImageSize below is NOT a sufficient
    // bound on its own: pdf.js checks it against the image DICTIONARY, then
    // PDFImage replaces those dimensions with the ones in the JPEG 2000 SIZ
    // marker before handing bytes to OpenJPEG -- so /Width 1 /Height 1 wrapping
    // a pathological codestream passes the check and still reaches the decoder.
    // Destroying the task terminates the worker, which is the only thing that
    // actually stops a wedged native decoder. Generous enough that no real
    // document trips it; a client-uploaded PDF that does gets an error surface
    // instead of a hung owner tab.
    //
    // `inFlightTask` is what makes the destroy above actually reachable.
    // `taskRef.current` is only assigned AFTER `await loadingTask.promise`
    // resolves, so during the parse phase -- the exact window this watchdog was
    // written for -- it is null and `taskRef.current?.destroy()` was a silent
    // no-op. A wedged decoder never resolves that promise, so nothing ever
    // terminated the worker and the timer only repainted the UI. getDocument()
    // returns the task synchronously, so capturing it there closes the gap.
    let inFlightTask: PDFDocumentLoadingTask | null = null;

    const watchdog = setTimeout(() => {
      if (cancelled || loadTokenRef.current !== token) return;
      cancelled = true;
      try { (taskRef.current ?? inFlightTask)?.destroy(); } catch { /* already gone */ }
      taskRef.current = null;
      inFlightTask = null;
      // 'timeout', not 'invalid' - the parse never finished, which says nothing
      // about whether the file is a valid PDF.
      setState({ status: 'error', error: 'timeout', pdf: null, pageMetas: [] });
      // Deliberately NOT getDocumentWatchdogged(): that helper's timer stops at the
      // getDocument promise, while this one has to span the per-page metadata loop
      // below as well. Same ceiling though, so the NUMBER is shared and cannot drift.
    }, PDFJS_PARSE_TIMEOUT_MS);

    (async () => {
      try {
        // The type is read off the bytes below; the row's name and type are not needed here.
        const fetched = await documentBytes({ id: docId, filename: '', mimeType: 'application/octet-stream' });
        if (cancelled) return;
        // A PNG/JPEG is wrapped in a one-page PDF so it can be marked up like
        // one. The wrapped bytes are the pristine copy too, so Export/Save
        // flatten onto the same page the marks were placed on.
        const imageKind = sniffWrappableImage(fetched);
        let bytes: Uint8Array;
        try {
          if (!imageKind && !hasPdfHeader(fetched)) throw new Error('not-annotatable');
          bytes = imageKind ? await wrapImageAsPdf(fetched, imageKind) : fetched;
        } catch {
          if (cancelled) return;
          setState({ status: 'error', error: 'image', pdf: null, pageMetas: [], imageErrorDocId: docId });
          return;
        }
        if (cancelled) return;
        // Pristine copy FIRST: pdfjs detaches `bytes`'s buffer below.
        pristineRef.current = bytes.slice(0);

        // PDFJS_DOC_OPTIONS is REQUIRED, not tuning: without its wasm/icc paths a
        // JPEG 2000 or JBIG2 page paints BLANK with only a console warning, and
        // it carries the image-size ceiling (see src/lib/pdfjs.ts). Spread it,
        // never re-inline it.
        const loadingTask = pdfjs.getDocument({
          ...PDFJS_DOC_OPTIONS,
          data: bytes,
        });
        // ARM THE WATCHDOG. getDocument() returns synchronously, so this runs
        // before the await below: which is the whole point: taskRef.current is
        // not assigned until after the promise resolves, and a wedged decoder
        // never resolves it. Without this line the watchdog's destroy() has
        // nothing to destroy and only repaints the UI.
        inFlightTask = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled || loadTokenRef.current !== token) {
          // Cleanup already ran (its destroy saw a null taskRef) or a newer
          // load owns proxyRef: destroy this orphan instead of leaking it.
          loadingTask.destroy().catch(() => undefined);
          return;
        }
        proxyRef.current = pdf;
        taskRef.current = loadingTask;

        // One metadata pass: page proxies are cached by pdfjs, so AnnotatorPage's
        // later getPage() calls resolve from cache.
        const metas: PageMeta[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          // Check per page, not just after the loop: the CHECK allows up to
          // 5000 pages, so a post-loop check makes a cancel wait out every
          // remaining getPage() before the proxy can be destroyed.
          if (cancelled || loadTokenRef.current !== token) return;
          const viewport = page.getViewport({ scale: 1 });
          metas.push({ widthPt: viewport.width, heightPt: viewport.height, rotation: page.rotate });
        }

        setState({ status: 'ready', error: null, pdf, pageMetas: metas });
      } catch (err) {
        if (cancelled) return;
        // pdfjs sets .name explicitly on its exceptions (survives minification).
        const name = (err as { name?: string } | null)?.name;
        setState({
          status: 'error',
          error: name === 'PasswordException' ? 'password' : 'invalid',
          pdf: null,
          pageMetas: [],
        });
      } finally {
        // Both outcomes disarm it. Without this the timer still fires 60s after
        // a SUCCESSFUL load and destroys the task under a working document.
        clearTimeout(watchdog);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      try {
        // Tears down the worker AND the document proxy it produced. `inFlightTask`
        // covers a close or switch DURING the parse: taskRef is only set once the
        // load resolves, so without it a wedged decode would keep its worker after
        // the annotator is gone.
        void (taskRef.current ?? inFlightTask)?.destroy().catch(() => undefined);
      } catch {
        // ignore
      }
      inFlightTask = null;
      taskRef.current = null;
      proxyRef.current = null;
      pristineRef.current = null;
    };
  }, [docId]);

  // The Export/Save flatten input: the untouched original bytes (null until
  // loaded). Returns a COPY: pdf-lib may transfer/mutate the array it's
  // handed, and the pristine buffer has to survive repeated Export/Save
  // clicks on one document.
  const getBytes = useCallback(() => pristineRef.current?.slice(0) ?? null, []);

  // Render-phase stall handler.
  //
  // The watchdog above bounds parse + metadata and then disarms: but `getDocument()`
  // only reads the file structure. JPX/JBIG2 bytes do not reach OpenJPEG until
  // `page.render()` pumps the operator list, which happens later, per visible page, in
  // AnnotatorPage. So the window this hook guarded ended just before the operation that
  // actually runs the native decoder. Found on the pre-land recheck of the e-sign
  // loaders, which had the identical gap.
  //
  // `RenderTask.cancel()` alone cannot fix it: cancellation is a flag the worker checks
  // between operations, and a wedged synchronous WASM decode never gets there. Destroying
  // the task terminates the worker, which is the only thing that does. That teardown has
  // to live here because this hook owns the task.
  const reportRenderStall = useCallback(() => {
    try { taskRef.current?.destroy(); } catch { /* already gone */ }
    taskRef.current = null;
    proxyRef.current = null;
    // Same reasoning as the parse watchdog: a render that ran past the ceiling
    // is a stall, not a corrupt document.
    setState({ status: 'error', error: 'timeout', pdf: null, pageMetas: [] });
  }, []);

  // Cheap readiness predicate for render-path checks: calling getBytes() just
  // to test for null would copy the whole PDF on every render.
  return { ...state, getBytes, reportRenderStall, hasBytes: state.status === 'ready' };
}
