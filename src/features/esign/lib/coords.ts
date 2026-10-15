/**
 * Coordinate spaces for field placement.
 *
 * Canvas space: pixels with a top-left origin (the rendered page).
 * PDF space: points with a bottom-left origin (what the fields table stores and what the
 * server stamps against).
 *
 * The y-flip is the only non-trivial part: a field's anchor on the canvas is its top-left
 * corner, while in PDF space the same field is anchored at its bottom-left corner,
 * pageHeight - (y + h) * scaleY. The two axes scale independently.
 */

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rect drawn on the canvas, in PDF points. Used when saving fields. */
export function canvasToPdf(
  rect: CanvasRect,
  pageWidthPt: number,
  pageHeightPt: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
): PdfRect {
  const scaleX = pageWidthPt / canvasWidthPx;
  const scaleY = pageHeightPt / canvasHeightPx;
  return {
    x: rect.x * scaleX,
    y: pageHeightPt - (rect.y + rect.h) * scaleY,
    width: rect.w * scaleX,
    height: rect.h * scaleY,
  };
}

/** A stored PDF rect, on the canvas. Used to draw a field over the rendered page. */
export function pdfToCanvas(
  rect: PdfRect,
  pageWidthPt: number,
  pageHeightPt: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
): CanvasRect {
  const scaleX = pageWidthPt / canvasWidthPx;
  const scaleY = pageHeightPt / canvasHeightPx;
  return {
    x: rect.x / scaleX,
    w: rect.width / scaleX,
    h: rect.height / scaleY,
    // Inverse of pdf.y = pageHeight - (canvas.y + canvas.h) * scaleY.
    y: (pageHeightPt - rect.y - rect.height) / scaleY,
  };
}
