/**
 * Coordinate spaces for field placement.
 *
 * Canvas space: pixels with a top-left origin, as the page is DRAWN (rotation applied).
 * PDF space: the page's unrotated user space in points, bottom-left origin, as the fields
 * table stores it and as the server stamps it (pdf-lib draws at x, y on the unrotated page).
 *
 * The mapping is pdf.js's own PageViewport transform, rebuilt here from the viewport's
 * viewBox (the CropBox, so its offset counts), rotation and scale. Scaling a canvas rect
 * by the page size alone drops both /Rotate and a CropBox that does not start at 0,0, and
 * the stamp then lands somewhere other than the preview.
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

/** What pdf.js's viewport says about a drawn page: `viewport.viewBox`, `.rotation`, `.scale`. */
export interface PageGeometry {
  viewBox: readonly [number, number, number, number];
  rotation: number;
  scale: number;
}

type Transform = [number, number, number, number, number, number];

/** pdf.js PageViewport's transform (offsetX/Y 0, not flipped): user space to canvas pixels. */
export function viewportTransform({ viewBox, rotation, scale }: PageGeometry): Transform {
  const [x0, y0, x1, y1] = viewBox;
  const cx = (x1 + x0) / 2;
  const cy = (y1 + y0) / 2;
  let r = rotation % 360;
  if (r < 0) r += 360;
  const [a, b, c, d] = r === 90 ? [0, 1, 1, 0] : r === 180 ? [-1, 0, 0, 1] : r === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const ox = a === 0 ? Math.abs(cy - y0) * scale : Math.abs(cx - x0) * scale;
  const oy = a === 0 ? Math.abs(cx - x0) * scale : Math.abs(cy - y0) * scale;
  return [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
}

function apply(t: Transform, x: number, y: number): [number, number] {
  return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
}

function invert(t: Transform): Transform {
  const det = t[0] * t[3] - t[1] * t[2];
  return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[4] * t[3]) / det, (t[4] * t[1] - t[5] * t[0]) / det];
}

function bounds(p: [number, number], q: [number, number]) {
  return { minX: Math.min(p[0], q[0]), minY: Math.min(p[1], q[1]), maxX: Math.max(p[0], q[0]), maxY: Math.max(p[1], q[1]) };
}

/** A rect drawn on the canvas, as user-space points (width and height swap at 90 and 270). */
export function canvasToPdf(rect: CanvasRect, geometry: PageGeometry): PdfRect {
  const inv = invert(viewportTransform(geometry));
  const b = bounds(apply(inv, rect.x, rect.y), apply(inv, rect.x + rect.w, rect.y + rect.h));
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

/** A stored user-space rect, on the canvas. */
export function pdfToCanvas(rect: PdfRect, geometry: PageGeometry): CanvasRect {
  const t = viewportTransform(geometry);
  const b = bounds(apply(t, rect.x, rect.y), apply(t, rect.x + rect.width, rect.y + rect.height));
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}
