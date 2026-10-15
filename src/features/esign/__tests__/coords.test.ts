import { describe, it, expect } from 'vitest';
import { canvasToPdf, pdfToCanvas } from '../lib/coords';

/**
 * canvasToPdf converts a canvas-space rect (top-left origin, pixels) to
 * PDF-space coords (bottom-left origin, points).
 *
 * pdfToCanvas is the inverse, used at render time to position existing
 * field overlays back onto the rendered page canvas.
 */

describe('canvasToPdf', () => {
  it('identity: 1:1 scale and aligned page sizes returns y-flipped coords with same dimensions', () => {
    // Page is 100x100 pt, canvas is 100x100 px. Rect at top-left (y=0) of canvas
    // (height 10) maps to PDF y = 100 - (0 + 10) = 90 (near top in PDF coords).
    const result = canvasToPdf(
      { x: 10, y: 0, w: 20, h: 10 },
      100, 100, 100, 100,
    );
    expect(result.x).toBe(10);
    expect(result.y).toBe(90);
    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
  });

  it('pure scale: canvas 200x200 → page 100x100 halves all dimensions', () => {
    const result = canvasToPdf(
      { x: 40, y: 60, w: 20, h: 10 },
      100, 100, 200, 200,
    );
    expect(result.x).toBe(20); // 40 * 0.5
    expect(result.width).toBe(10); // 20 * 0.5
    expect(result.height).toBe(5); // 10 * 0.5
    // y-flip: pageHeight - (rect.y + rect.h) * scaleY = 100 - (60+10)*0.5 = 100 - 35 = 65
    expect(result.y).toBe(65);
  });

  it('y-flip at top edge: canvas y=0 → PDF y = pageHeight - h*scaleY', () => {
    const result = canvasToPdf(
      { x: 0, y: 0, w: 50, h: 25 },
      400, 600, 800, 1200,
    );
    // scaleY = 600/1200 = 0.5; PDF y = 600 - (0+25)*0.5 = 600 - 12.5 = 587.5
    expect(result.y).toBe(587.5);
    expect(result.height).toBe(12.5);
  });

  it('y-flip at bottom edge: a rect flush with the canvas bottom maps to PDF y = 0', () => {
    // canvas height 1200 px, rect bottom at y+h = 1200 → PDF y = 600 - 1200*0.5 = 0
    const result = canvasToPdf(
      { x: 0, y: 1100, w: 100, h: 100 },
      400, 600, 800, 1200,
    );
    expect(result.y).toBe(0);
    expect(result.height).toBe(50);
  });

  it('non-square aspect ratios use independent x/y scales', () => {
    const result = canvasToPdf(
      { x: 100, y: 50, w: 40, h: 20 },
      400, 800, 800, 1600,
    );
    // scaleX = 400/800 = 0.5; scaleY = 800/1600 = 0.5
    expect(result.x).toBe(50);
    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
    // y = 800 - (50 + 20) * 0.5 = 800 - 35 = 765
    expect(result.y).toBe(765);
  });
});

describe('pdfToCanvas', () => {
  it('inverts canvasToPdf: round-trip yields the original rect', () => {
    const original = { x: 100, y: 200, w: 60, h: 30 };
    const pdf = canvasToPdf(original, 612, 792, 800, 1035);
    const back = pdfToCanvas(
      { x: pdf.x, y: pdf.y, width: pdf.width, height: pdf.height },
      612, 792, 800, 1035,
    );
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.w).toBeCloseTo(original.w, 6);
    expect(back.h).toBeCloseTo(original.h, 6);
  });

  it('places a field at PDF y=0 (bottom of page) flush against the canvas bottom', () => {
    const back = pdfToCanvas(
      { x: 0, y: 0, width: 50, height: 25 },
      400, 600, 800, 1200,
    );
    // canvas y = (pageHeight - pdf.y - pdf.height) / scaleY = (600 - 0 - 25) / 0.5 = 1150
    expect(back.y).toBe(1150);
    expect(back.h).toBe(50);
  });
});
