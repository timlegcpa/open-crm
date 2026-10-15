import { describe, expect, it } from 'vitest';
import { canvasToPdf, pdfToCanvas, viewportTransform, type PageGeometry } from '../lib/coords';

/**
 * Field coordinates are user-space points on the UNROTATED page, which is where the server
 * stamps them. The expected transforms below were read from real pdf.js
 * (`page.getViewport({ scale }).transform`) on pages pdf-lib built with these sizes,
 * rotations and CropBoxes, so the rebuilt transform is held to pdf.js itself.
 */
const PDFJS: Array<{ geometry: PageGeometry; transform: number[] }> = [
  { geometry: { viewBox: [0, 0, 612, 792], rotation: 90, scale: 1 }, transform: [0, 1, 1, 0, 0, 0] },
  { geometry: { viewBox: [50, 40, 562, 742], rotation: 0, scale: 1.5 }, transform: [1.5, 0, 0, -1.5, -75, 1113] },
  { geometry: { viewBox: [50, 40, 562, 742], rotation: 270, scale: 2 }, transform: [0, -2, -2, 0, 1484, 1124] },
  { geometry: { viewBox: [10, 20, 300, 400], rotation: 180, scale: 1.2 }, transform: [-1.2, 0, 0, 1.2, 360, -24] },
];

const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6 + 0]));

describe('the viewport transform', () => {
  it.each(PDFJS)('equals pdf.js for $geometry.rotation degrees, viewBox $geometry.viewBox', ({ geometry, transform }) => {
    expect(viewportTransform(geometry).map((n) => Math.round(n * 1e6) / 1e6 + 0)).toEqual(transform);
  });
});

describe('canvas to user space', () => {
  it('an unrotated letter page at 1x is the plain y-flip', () => {
    const g: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: 0, scale: 1 };
    expect(canvasToPdf({ x: 10, y: 0, w: 20, h: 10 }, g)).toEqual({ x: 10, y: 782, width: 20, height: 10 });
  });

  it('a page rotated 90 degrees: the preview box lands on the same spot, width and height swapped', () => {
    // The review case: 612x792 rotated 90, preview box (650, 10, 100, 30). The old
    // size-only scaling stored (650, 572, ...), which the stamp put somewhere else.
    const g: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: 90, scale: 1 };
    const stored = canvasToPdf({ x: 650, y: 10, w: 100, h: 30 }, g);
    expect(stored).toEqual({ x: 10, y: 650, width: 30, height: 100 });
    expect(stored.x + stored.width).toBeLessThanOrEqual(612);
    expect(stored.y + stored.height).toBeLessThanOrEqual(792);
  });

  it('a CropBox that does not start at 0,0 offsets the stored point', () => {
    const g: PageGeometry = { viewBox: [50, 40, 562, 742], rotation: 0, scale: 1 };
    // The crop's top-left corner on screen is user space (50, 742).
    expect(round({ ...canvasToPdf({ x: 0, y: 0, w: 100, h: 20 }, g) })).toEqual({ x: 50, y: 722, width: 100, height: 20 });
  });

  it.each(PDFJS)('round-trips at $geometry.rotation degrees', ({ geometry }) => {
    const rect = { x: 37, y: 112, w: 140, h: 34 };
    expect(round({ ...pdfToCanvas(canvasToPdf(rect, geometry), geometry) })).toEqual(rect);
  });
});
