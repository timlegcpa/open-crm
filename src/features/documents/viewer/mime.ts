/**
 * Preview-relevant mime-type predicates, pulled out of `PreviewSurface.tsx` so
 * a caller that only needs "is this a PDF / is this zoomable" (DocumentWorkstation's
 * keyboard/zoom logic) doesn't have to statically import the component that
 * owns the docx/xlsx/csv renderers. `PreviewSurface.tsx` is loaded via
 * `lazy(() => import(...))` precisely so those renderers stay out of the entry
 * chunk: a static import of anything from that same module (even a pure
 * function) pulls the whole module, and its renderers, into the eager graph
 * regardless, defeating the lazy load.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';
export const TEXT_MIME = 'text/plain';

export function isWordDoc(mimeType: string): boolean {
  return mimeType === DOCX_MIME || mimeType === DOC_MIME;
}

export function isPdf(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

/**
 * Opens on the annotation surface (PdfSurface). PNG and JPEG are wrapped in a
 * one-page PDF on load (`src/lib/imageToPdf.ts`); other images stay on the
 * plain preview because pdf-lib cannot embed them.
 */
export function isAnnotatable(mimeType: string): boolean {
  return isPdf(mimeType) || mimeType === 'image/png' || mimeType === 'image/jpeg';
}

export function isPreviewable(mimeType: string): boolean {
  return (
    isPdf(mimeType) ||
    mimeType.startsWith('image/') ||
    isWordDoc(mimeType) ||
    mimeType === XLSX_MIME ||
    mimeType === CSV_MIME ||
    mimeType === TEXT_MIME
  );
}

export function isZoomableMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') || isPdf(mimeType) || isWordDoc(mimeType) || mimeType === TEXT_MIME
  );
}
