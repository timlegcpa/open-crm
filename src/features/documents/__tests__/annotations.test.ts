import { describe, it, expect } from 'vitest';
import {
  INK_COLORS,
  HIGHLIGHT_COLORS,
  REVIEW_STAMP_MARGIN,
  REVIEW_STAMP_META,
  REVIEW_STAMP_SIZE,
  STAMP_META,
  TEXT_MAX_LEN,
  describeAnnotation,
  isAnnotationData,
  isReviewStampKey,
  normalizeRect,
  pdfSvgPathFromPoints,
  reviewStampLines,
  reviewStampRect,
  round2,
  svgPathFromPoints,
  type DocumentAnnotation,
  type ReviewStampData,
  type StampKey,
} from '../lib/annotations';

describe('round2', () => {
  it('rounds to 2 decimals', () => {
    expect(round2(1.239)).toBe(1.24);
    expect(round2(10)).toBe(10);
    expect(round2(-3.456)).toBe(-3.46);
  });
});

describe('svgPathFromPoints', () => {
  it('emits M then L commands', () => {
    expect(svgPathFromPoints([[0, 0], [10, 20], [30, 5]])).toBe('M 0 0 L 10 20 L 30 5');
  });

  it('rounds coordinates to 2 decimals', () => {
    expect(svgPathFromPoints([[1.239, 2.5551], [3.1, 4]])).toBe('M 1.24 2.56 L 3.1 4');
  });
});

describe('pdfSvgPathFromPoints', () => {
  it('flips y against page height', () => {
    expect(pdfSvgPathFromPoints([[10, 20], [30, 40]], 100)).toBe('M 10 80 L 30 60');
  });

  it('handles the page-height edges: y=0 maps to pageHeight, y=pageHeight maps to 0', () => {
    expect(pdfSvgPathFromPoints([[5, 0], [5, 792]], 792)).toBe('M 5 792 L 5 0');
  });

  it('round-trips with svgPathFromPoints under double flip', () => {
    const points: [number, number][] = [[12.5, 30], [40, 700.25]];
    const flippedOnce = points.map(([x, y]) => [x, 792 - y] as [number, number]);
    expect(pdfSvgPathFromPoints(flippedOnce, 792)).toBe(svgPathFromPoints(points));
  });
});

describe('normalizeRect', () => {
  const expected = { x: 10, y: 20, width: 30, height: 40 };

  it('top-left to bottom-right drag', () => {
    expect(normalizeRect([10, 20], [40, 60])).toEqual(expected);
  });

  it('bottom-right to top-left drag', () => {
    expect(normalizeRect([40, 60], [10, 20])).toEqual(expected);
  });

  it('top-right to bottom-left drag', () => {
    expect(normalizeRect([40, 20], [10, 60])).toEqual(expected);
  });

  it('bottom-left to top-right drag', () => {
    expect(normalizeRect([10, 60], [40, 20])).toEqual(expected);
  });

  it('rounds output to 2 decimals', () => {
    expect(normalizeRect([1.111, 2.222], [3.333, 4.444])).toEqual({
      x: 1.11, y: 2.22, width: 2.22, height: 2.22,
    });
  });
});

describe('isAnnotationData', () => {
  const validInk = { points: [[1, 2], [3, 4]], color: '#DC2626', width: 2 };
  const validHighlight = { x: 10, y: 20, width: 100, height: 18, color: '#FDE047' };
  const validText = { x: 5, y: 5, text: 'note', color: '#111827', fontSize: 12 };
  const validStamp = { x: 5, y: 5, size: 24, stamp: 'check' };

  it('accepts every valid shape', () => {
    expect(isAnnotationData('ink', validInk)).toBe(true);
    expect(isAnnotationData('highlight', validHighlight)).toBe(true);
    expect(isAnnotationData('text', validText)).toBe(true);
    expect(isAnnotationData('stamp', validStamp)).toBe(true);
  });

  it('accepts boundary values: text at exactly TEXT_MAX_LEN, empty text, zero-size highlight', () => {
    expect(isAnnotationData('text', { ...validText, text: 'a'.repeat(TEXT_MAX_LEN) })).toBe(true);
    expect(isAnnotationData('text', { ...validText, text: '' })).toBe(true);
    expect(isAnnotationData('highlight', { ...validHighlight, width: 0, height: 0 })).toBe(true);
  });

  it('rejects wrong kind/data pairings', () => {
    expect(isAnnotationData('ink', validHighlight)).toBe(false);
    expect(isAnnotationData('highlight', validInk)).toBe(false);
    expect(isAnnotationData('text', validStamp)).toBe(false);
    expect(isAnnotationData('stamp', validText)).toBe(false);
  });

  it('rejects non-object data', () => {
    expect(isAnnotationData('ink', null)).toBe(false);
    expect(isAnnotationData('ink', undefined)).toBe(false);
    expect(isAnnotationData('ink', 'string')).toBe(false);
    expect(isAnnotationData('ink', 42)).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(isAnnotationData('highlight', { ...validHighlight, x: NaN })).toBe(false);
    expect(isAnnotationData('highlight', { ...validHighlight, width: Infinity })).toBe(false);
    expect(isAnnotationData('text', { ...validText, fontSize: NaN })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, points: [[1, NaN], [3, 4]] })).toBe(false);
  });

  it('rejects oversized text', () => {
    expect(isAnnotationData('text', { ...validText, text: 'a'.repeat(TEXT_MAX_LEN + 1) })).toBe(false);
  });

  it('rejects unknown stamp keys', () => {
    expect(isAnnotationData('stamp', { ...validStamp, stamp: 'star' })).toBe(false);
    expect(isAnnotationData('stamp', { ...validStamp, stamp: 42 })).toBe(false);
  });

  // The freehand highlighter is `ink` carrying an optional opacity: this guard
  // is the only thing between a hand-edited jsonb row and the renderer/flatten.
  it('accepts ink with no opacity (the opaque-pen default) and with a valid alpha', () => {
    expect(isAnnotationData('ink', validInk)).toBe(true);
    expect(isAnnotationData('ink', { ...validInk, opacity: 0.35 })).toBe(true);
    expect(isAnnotationData('ink', { ...validInk, opacity: 1 })).toBe(true);
  });

  it('rejects ink opacity outside (0, 1] or of the wrong type', () => {
    // 0 would persist a row that renders nothing at all.
    expect(isAnnotationData('ink', { ...validInk, opacity: 0 })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, opacity: 1.5 })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, opacity: -0.5 })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, opacity: NaN })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, opacity: '0.5' })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, opacity: null })).toBe(false);
  });

  it('rejects malformed points', () => {
    expect(isAnnotationData('ink', { ...validInk, points: [[1, 2]] })).toBe(false); // < 2 points
    expect(isAnnotationData('ink', { ...validInk, points: [[1], [2, 3]] })).toBe(false); // non-pair
    expect(isAnnotationData('ink', { ...validInk, points: [[1, 2, 3], [4, 5]] })).toBe(false); // triple
    expect(isAnnotationData('ink', { ...validInk, points: 'nope' })).toBe(false); // non-array
    expect(isAnnotationData('ink', { ...validInk, points: [['a', 'b'], [1, 2]] })).toBe(false); // strings
  });

  it('rejects invalid colors', () => {
    expect(isAnnotationData('ink', { ...validInk, color: 'red' })).toBe(false);
    expect(isAnnotationData('ink', { ...validInk, color: '#FFF' })).toBe(false);
    expect(isAnnotationData('highlight', { ...validHighlight, color: '#GGGGGG' })).toBe(false);
    expect(isAnnotationData('text', { ...validText, color: 12345 })).toBe(false);
  });

  it('rejects non-positive width, fontSize, size', () => {
    expect(isAnnotationData('ink', { ...validInk, width: 0 })).toBe(false);
    expect(isAnnotationData('text', { ...validText, fontSize: -1 })).toBe(false);
    expect(isAnnotationData('stamp', { ...validStamp, size: 0 })).toBe(false);
  });
});

describe('STAMP_META', () => {
  const COMMAND_ARG_COUNTS: Record<string, number> = { M: 2, L: 2, C: 6, Q: 4 };

  it.each(Object.keys(STAMP_META) as StampKey[])(
    '%s path uses only absolute M/L/C/Q with finite coords inside the 24-box',
    (key) => {
      const tokens = STAMP_META[key].path.trim().split(/\s+/);
      let i = 0;
      while (i < tokens.length) {
        const cmd = tokens[i];
        expect(Object.keys(COMMAND_ARG_COUNTS)).toContain(cmd);
        const argCount = COMMAND_ARG_COUNTS[cmd];
        for (let a = 1; a <= argCount; a++) {
          const n = Number(tokens[i + a]);
          expect(Number.isFinite(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(24);
        }
        i += 1 + argCount;
      }
      expect(i).toBe(tokens.length); // no trailing garbage
    },
  );

  it('each stamp carries a #rrggbb color and a label', () => {
    for (const meta of Object.values(STAMP_META) as Array<{ color: string; label: string }>) {
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });
});

describe('color palettes', () => {
  it('all palette entries are #rrggbb', () => {
    for (const c of [...INK_COLORS, ...HIGHLIGHT_COLORS]) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('review stamps', () => {
  const validReviewStamp: ReviewStampData = {
    x: 420, y: 24, width: 168, height: 46,
    stamp: 'reviewed',
    stampedAt: '2026-08-05T19:42:00.000Z',
  };

  it('isReviewStampKey separates the two key spaces', () => {
    // The narrowing that stops a review key reaching a plain 'stamp' row.
    expect(isReviewStampKey('reviewed')).toBe(true);
    expect(isReviewStampKey('approved')).toBe(true);
    expect(isReviewStampKey('check')).toBe(false);
    expect(isReviewStampKey('cross')).toBe(false);
    expect(isReviewStampKey('question')).toBe(false);
  });

  it('the two stamp key spaces are disjoint', () => {
    for (const k of Object.keys(STAMP_META)) {
      expect(isReviewStampKey(k as StampKey)).toBe(false);
    }
  });

  it('reviewStampRect sits inside the page at the bottom-right, portrait and landscape', () => {
    for (const [w, h] of [[612, 792], [792, 612]] as const) {
      const r = reviewStampRect(w, h);
      expect(r.x + r.width).toBeCloseTo(w - REVIEW_STAMP_MARGIN, 2);
      expect(r.y).toBeCloseTo(REVIEW_STAMP_MARGIN, 2);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y + r.height).toBeLessThanOrEqual(h);
      expect(r.width).toBe(REVIEW_STAMP_SIZE.width);
      expect(r.height).toBe(REVIEW_STAMP_SIZE.height);
    }
  });

  it('reviewStampRect never emits negative coordinates on a page smaller than the stamp', () => {
    const r = reviewStampRect(100, 30);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.width).toBeLessThanOrEqual(100);
    expect(r.height).toBeLessThanOrEqual(30);
  });

  it('reviewStampLines returns the uppercase label and a rendered timestamp', () => {
    const [label, when] = reviewStampLines(validReviewStamp);
    expect(label).toBe('REVIEWED');
    expect(when).not.toMatch(/Invalid/);
    expect(when.length).toBeGreaterThan(0);
    expect(reviewStampLines({ ...validReviewStamp, stamp: 'approved' })[0]).toBe('APPROVED');
  });

  it('accepts a valid review_stamp', () => {
    expect(isAnnotationData('review_stamp', validReviewStamp)).toBe(true);
  });

  it('rejects a review_stamp with an unparseable stampedAt: it gets DRAWN into the PDF', () => {
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, stampedAt: 'nope' })).toBe(false);
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, stampedAt: 42 })).toBe(false);
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, stampedAt: undefined })).toBe(false);
  });

  it('rejects an unknown key, a zero dimension, and a plain stamp key', () => {
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, stamp: 'check' })).toBe(false);
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, stamp: 'nope' })).toBe(false);
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, height: 0 })).toBe(false);
    expect(isAnnotationData('review_stamp', { ...validReviewStamp, width: -1 })).toBe(false);
  });

  it('each review stamp carries a #rrggbb color and a label', () => {
    for (const meta of Object.values(REVIEW_STAMP_META) as Array<{ color: string; label: string }>) {
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });
});

describe('describeAnnotation', () => {
  const row = (kind: string, data: unknown): DocumentAnnotation =>
    ({
      id: 'a1', document_id: 'd1', page_index: 0,
      kind, data,
      created_at: '2026-08-05T12:00:00Z', updated_at: '2026-08-05T12:00:00Z',
    }) as DocumentAnnotation;

  it('separates a pen Drawing from a freehand Marker by opacity', () => {
    const points = [[1, 2], [3, 4]];
    expect(describeAnnotation(row('ink', { points, color: '#DC2626', width: 2 }))).toBe('Drawing');
    expect(
      describeAnnotation(row('ink', { points, color: '#FDE047', width: 22, opacity: 0.35 })),
    ).toBe('Marker');
  });

  it('quotes and truncates a long note', () => {
    const long = 'a'.repeat(80);
    const out = describeAnnotation(row('text', { x: 1, y: 1, text: long, color: '#111827', fontSize: 12 }));
    expect(out.startsWith('Note: “')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(long.length);
  });

  it('collapses whitespace and handles an empty note', () => {
    expect(
      describeAnnotation(row('text', { x: 1, y: 1, text: 'two   \n lines', color: '#111827', fontSize: 12 })),
    ).toBe('Note: “two lines”');
    expect(
      describeAnnotation(row('text', { x: 1, y: 1, text: '   ', color: '#111827', fontSize: 12 })),
    ).toBe('Note');
  });

  it('uses the stamp labels', () => {
    expect(describeAnnotation(row('highlight', { x: 1, y: 1, width: 5, height: 5, color: '#FDE047' }))).toBe('Highlight');
    expect(describeAnnotation(row('stamp', { x: 1, y: 1, size: 24, stamp: 'check' }))).toBe('Check');
    expect(
      describeAnnotation(
        row('review_stamp', {
          x: 1, y: 1, width: 168, height: 46, stamp: 'reviewed', stampedAt: '2026-08-05T12:00:00Z',
        }),
      ),
    ).toBe('REVIEWED');
  });

  it('degrades a malformed row to a generic label instead of throwing', () => {
    // The panel must survive the same hand-edited jsonb the renderer guards against.
    expect(describeAnnotation(row('ink', { points: 'nope' }))).toBe('Mark');
    expect(describeAnnotation(row('stamp', { x: 1, y: 1, size: 24, stamp: 'star' }))).toBe('Mark');
    expect(describeAnnotation(row('review_stamp', { x: 1, y: 1, width: 1, height: 1, stamp: 'reviewed', stampedAt: 'nope' }))).toBe('Mark');
  });
});
