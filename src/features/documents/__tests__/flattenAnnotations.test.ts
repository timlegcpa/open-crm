import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFPage, degrees } from 'pdf-lib';
import { flattenAnnotatedPdf } from '../lib/flattenAnnotations';
import type { AnnotationData, DocumentAnnotation } from '../lib/annotations';

const ann = (
  over: Omit<Partial<DocumentAnnotation>, 'data'> & { data?: unknown },
): DocumentAnnotation => {
  const { data, ...rest } = over;
  return {
    id: crypto.randomUUID(),
    document_id: 'doc-1',
    page_index: 0,
    kind: 'highlight',
    data: (data ?? { x: 10, y: 10, width: 100, height: 20, color: '#FDE047' }) as AnnotationData,
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    ...rest,
  };
};

// 2-page doc, second page rotated 90°: exercises the rotation-aware text path.
async function makeTwoPageDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  p2.setRotation(degrees(90));
  return doc.save();
}

// Build bytes with the test environment's own Uint8Array: TextEncoder output can
// come from a different realm under vitest, failing pdf-lib's instanceof check.
const asciiBytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

// Minimal PDF whose trailer carries an /Encrypt entry: pdf-lib refuses it at
// load time with its encrypted-document error.
const ENCRYPTED_FIXTURE = asciiBytes(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
4 0 obj
<< /Filter /Standard /V 1 /R 2 /P -44 >>
endobj
trailer
<< /Root 1 0 R /Encrypt 4 0 R /Size 5 >>
%%EOF`);

describe('flattenAnnotatedPdf', () => {
  it('flattens one annotation of each kind, skips malformed and out-of-range rows, and preserves page count', async () => {
    const bytes = await makeTwoPageDoc();
    const annotations: DocumentAnnotation[] = [
      ann({ kind: 'highlight', page_index: 0 }),
      ann({
        kind: 'ink',
        page_index: 0,
        data: { points: [[50, 50], [100, 120], [150, 60]], color: '#DC2626', width: 2 },
      }),
      // Text on the rotated page, with an emoji that must be stripped, not thrown on.
      ann({
        kind: 'text',
        page_index: 1,
        data: { x: 40, y: 40, text: 'Verify this \u{1F600} figure', color: '#111827', fontSize: 12 },
      }),
      // Near-edge text on the rotated page: exercises the maxWidth >= 72 clamp.
      ann({
        kind: 'text',
        page_index: 1,
        data: { x: 40, y: 790, text: 'edge note', color: '#111827', fontSize: 12 },
      }),
      // Freehand highlighter: ink carrying an opacity, which routes through the
      // blendMode + round-cap branch rather than the plain-pen one.
      ann({
        kind: 'ink',
        page_index: 0,
        data: {
          points: [[60, 200], [140, 210], [220, 195]],
          color: '#FDE047',
          width: 22,
          opacity: 0.35,
        },
      }),
      ann({
        kind: 'stamp',
        page_index: 1,
        data: { x: 200, y: 200, size: 24, stamp: 'question' },
      }),
      // Review stamp on the ROTATED page: its own flatten arm. This row is the
      // tripwire for the bare-`else` hazard: before the explicit dispatch, a kind
      // with no arm was cast to StampData and read STAMP_META[undefined].
      ann({
        kind: 'review_stamp',
        page_index: 1,
        data: {
          x: 420, y: 24, width: 168, height: 46,
          stamp: 'reviewed',
          stampedAt: '2026-08-05T19:42:00.000Z',
        },
      }),
      ann({
        kind: 'review_stamp',
        page_index: 0,
        data: {
          x: 420, y: 24, width: 168, height: 46,
          stamp: 'approved',
          stampedAt: '2026-08-05T19:43:00.000Z',
        },
      }),
      // Malformed review stamp: unparseable timestamp would otherwise DRAW
      // "Invalid Date" into a PDF that goes to a client.
      ann({
        kind: 'review_stamp',
        page_index: 0,
        data: { x: 10, y: 10, width: 168, height: 46, stamp: 'reviewed', stampedAt: 'nope' },
      }),
      // Out-of-range page: skipped, never thrown.
      ann({ kind: 'highlight', page_index: 7 }),
      // Malformed jsonb row: fails isAnnotationData, skipped.
      ann({ kind: 'ink', page_index: 0, data: { points: 'nope', color: '#DC2626', width: 2 } }),
    ];

    const out = await flattenAnnotatedPdf(bytes, annotations);
    expect(out).toBeInstanceOf(Uint8Array);

    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it('resolves with zero annotations and keeps page count unchanged', async () => {
    const bytes = await makeTwoPageDoc();
    const out = await flattenAnnotatedPdf(bytes, []);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("throws Error('encrypted-pdf') for a password-protected input", async () => {
    const err = await flattenAnnotatedPdf(ENCRYPTED_FIXTURE, []).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('encrypted-pdf');
  });

  it('rethrows corrupted-bytes errors UNtagged: the encrypted/corrupted distinction is the contract', async () => {
    const garbage = asciiBytes('this is not a pdf at all');
    const err = await flattenAnnotatedPdf(garbage, []).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toBe('encrypted-pdf');
  });

  // drawSvgPath applies translate → rotate → y-down scale, so a path point
  // (px, py) lands at anchor + R(θ)·(px·s, −py·s). Spy on the call (the
  // source's dynamic import resolves to this same pdf-lib instance), map the
  // 24-box's corners through that transform, and assert their bounding box IS
  // the annotation's on-screen box [x, x+size]×[y, y+size] for every /Rotate.
  it.each([0, 90, 180, 270])(
    'anchors a stamp on a /Rotate %d page so the drawn glyph fills the on-screen box',
    async (angle) => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]).setRotation(degrees(angle));
      const bytes = await doc.save();

      const stamp = { x: 120, y: 340, size: 32, stamp: 'check' as const };
      const spy = vi.spyOn(PDFPage.prototype, 'drawSvgPath');
      try {
        await flattenAnnotatedPdf(bytes, [ann({ kind: 'stamp', data: stamp })]);

        expect(spy).toHaveBeenCalledTimes(1);
        const opts = spy.mock.calls[0][1]!;
        expect(opts.rotate).toEqual(degrees(angle));

        const s = opts.scale as number;
        const rad = (angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const corners = [
          [0, 0],
          [24, 0],
          [0, 24],
          [24, 24],
        ].map(([px, py]) => {
          const vx = px * s;
          const vy = -py * s;
          return {
            x: (opts.x as number) + vx * cos - vy * sin,
            y: (opts.y as number) + vx * sin + vy * cos,
          };
        });
        expect(Math.min(...corners.map((c) => c.x))).toBeCloseTo(stamp.x, 6);
        expect(Math.max(...corners.map((c) => c.x))).toBeCloseTo(stamp.x + stamp.size, 6);
        expect(Math.min(...corners.map((c) => c.y))).toBeCloseTo(stamp.y, 6);
        expect(Math.max(...corners.map((c) => c.y))).toBeCloseTo(stamp.y + stamp.size, 6);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // The stored rect is axis-aligned in UNROTATED space (the overlay renders it
  // as-is), so the contract is: the box is drawn exactly as stored with NO
  // rotation, while the two text lines rotate to read upright and stay inside
  // the box, sized against the box's DISPLAYED height. Fixtures are the
  // hand-derived stored rects for a bottom-right stamp (168×46 displayed, 24pt
  // margins) on a 612×792 page under each /Rotate: the same rects placement
  // stores after its viewport round-trip (displayed dims swap on 90/270).
  it.each([
    [0, { x: 420, y: 24, width: 168, height: 46 }],
    [90, { x: 542, y: 600, width: 46, height: 168 }],
    [180, { x: 24, y: 722, width: 168, height: 46 }],
    [270, { x: 24, y: 24, width: 46, height: 168 }],
  ] as const)(
    'draws a review stamp on a /Rotate %d page as an unrotated box with upright text inside it',
    async (angle, rect) => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]).setRotation(degrees(angle));
      const bytes = await doc.save();
      const helvetica = await doc.embedFont('Helvetica');

      const rectSpy = vi.spyOn(PDFPage.prototype, 'drawRectangle');
      const textSpy = vi.spyOn(PDFPage.prototype, 'drawText');
      try {
        await flattenAnnotatedPdf(bytes, [
          ann({
            kind: 'review_stamp',
            data: { ...rect, stamp: 'reviewed', stampedAt: '2026-08-05T19:42:00.000Z' },
          }),
        ]);

        // Box: exactly the stored rect, never rotated: rotating about (x, y)
        // is what drew a different box than the overlay on /Rotate pages.
        expect(rectSpy).toHaveBeenCalledTimes(1);
        const box = rectSpy.mock.calls[0][0]!;
        expect(box.x).toBe(rect.x);
        expect(box.y).toBe(rect.y);
        expect(box.width).toBe(rect.width);
        expect(box.height).toBe(rect.height);
        expect(box.rotate).toBeUndefined();

        // Text: both lines rotated to the page angle, sized off the DISPLAYED
        // height (46 at every angle here), and fully inside the stored box.
        expect(textSpy).toHaveBeenCalledTimes(2);
        const sideways = angle === 90 || angle === 270;
        const displayedH = sideways ? rect.width : rect.height;
        const rad = (angle * Math.PI) / 180;
        const cos = Math.round(Math.cos(rad));
        const sin = Math.round(Math.sin(rad));
        const sizes = textSpy.mock.calls.map((c) => c[1]!.size as number).sort((a, b) => b - a);
        expect(sizes[0]).toBeCloseTo(displayedH * 0.42, 6);
        expect(sizes[1]).toBeCloseTo(displayedH * 0.2, 6);
        for (const [text, opts] of textSpy.mock.calls) {
          expect(opts!.rotate).toEqual(degrees(angle));
          const size = opts!.size as number;
          const w = helvetica.widthOfTextAtSize(text as string, size);
          // Baseline start, baseline end, and cap-height top must all land in
          // the stored box (± half a point for rounding).
          const pts = [
            [0, 0],
            [w, 0],
            [0, size * 0.72],
            [w, size * 0.72],
          ].map(([along, up]) => ({
            x: (opts!.x as number) + along * cos - up * sin,
            y: (opts!.y as number) + along * sin + up * cos,
          }));
          for (const p of pts) {
            expect(p.x).toBeGreaterThanOrEqual(rect.x - 0.5);
            expect(p.x).toBeLessThanOrEqual(rect.x + rect.width + 0.5);
            expect(p.y).toBeGreaterThanOrEqual(rect.y - 0.5);
            expect(p.y).toBeLessThanOrEqual(rect.y + rect.height + 0.5);
          }
        }
      } finally {
        rectSpy.mockRestore();
        textSpy.mockRestore();
      }
    },
  );

  it('draws every stamp key without throwing', async () => {
    const bytes = await makeTwoPageDoc();
    const annotations: DocumentAnnotation[] = (['check', 'cross', 'question'] as const).map(
      (stamp, i) =>
        ann({ kind: 'stamp', page_index: 0, data: { x: 50 + i * 40, y: 300, size: 32, stamp } }),
    );
    const out = await flattenAnnotatedPdf(bytes, annotations);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
  });
});
