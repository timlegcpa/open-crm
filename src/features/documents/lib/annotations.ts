import { formatDateTime } from '@/lib/format';

export type AnnotationKind = 'ink' | 'highlight' | 'text' | 'stamp' | 'review_stamp';
export type StampKey = 'check' | 'cross' | 'question';
export type ReviewStampKey = 'reviewed' | 'approved' | 'not_needed';

// All coordinates: UNROTATED PDF space, points, bottom-left origin (pdf-lib native).
/**
 * `opacity` absent ⇒ fully opaque pen ink (every row written before 2026-08-05).
 * Present ⇒ a freehand HIGHLIGHTER stroke: same geometry, drawn translucent and
 * multiplied so text underneath stays readable. Reusing `ink` rather than adding
 * a kind is deliberate: a marker IS a fat translucent stroke, and the DB's
 * `document_annotations_kind_check` stays untouched.
 */
export interface InkData { points: [number, number][]; color: string; width: number; opacity?: number }
export interface HighlightData { x: number; y: number; width: number; height: number; color: string }
export interface TextData { x: number; y: number; text: string; color: string; fontSize: number }
export interface StampData { x: number; y: number; size: number; stamp: StampKey }
/**
 * A dated review mark drawn as a bordered box with a label and a timestamp line.
 * `stampedAt` is STORED rather than derived from the row's `created_at`: the
 * flatten path never sees DB columns, and the drawn text must not shift if the
 * row is ever re-saved.
 */
export interface ReviewStampData {
  x: number; y: number;            // box bottom-left, unrotated PDF points
  width: number; height: number;
  stamp: ReviewStampKey;
  stampedAt: string;               // ISO
}
export type AnnotationData = InkData | HighlightData | TextData | StampData | ReviewStampData;

export interface DocumentAnnotation {
  id: string;
  document_id: string;
  page_index: number;
  kind: AnnotationKind;
  data: AnnotationData;
  created_at: string;
  updated_at: string;
}

export const INK_COLORS: readonly string[] = ['#DC2626', '#1D4ED8', '#15803D', '#111827'];
export const HIGHLIGHT_COLORS: readonly string[] = ['#FDE047', '#86EFAC', '#93C5FD'];
export const HIGHLIGHT_OPACITY = 0.35;
export const TEXT_MAX_LEN = 2000;

/** Box = drag a rectangle (original behavior). Freehand = drag a marker stroke. */
export type HighlightMode = 'box' | 'freehand';
/** Freehand marker brush widths, in PDF points. */
export const HIGHLIGHT_BRUSHES = [8, 14, 22] as const;

// Paths live in a 0 0 24 24 viewBox (y-down), absolute M/L/C/Q commands ONLY , 
// pdf-lib's SVG path support is partial (no arcs), and these strings feed both
// the SVG overlay (<path d>) and the flatten (drawSvgPath).
export const STAMP_META: Record<StampKey, { label: string; color: string; path: string }> = {
  check: { label: 'Check', color: '#15803D', path: 'M 4 13 L 9.5 18.5 L 20 5.5' },
  cross: { label: 'Cross', color: '#DC2626', path: 'M 5 5 L 19 19 M 19 5 L 5 19' },
  question: {
    label: 'Question',
    color: '#B45309',
    path: 'M 7.5 8 C 7.5 3.5 16.5 3.5 16.5 8 C 16.5 11.5 12 11 12 15 M 12 18.5 L 12 20.5',
  },
};

/**
 * `labelEm`: the label's width at 1pt in Helvetica Bold, the stamp's on-screen face (the
 * export measures its own font). A test holds it to pdf-lib's own metrics.
 */
export const REVIEW_STAMP_META: Record<ReviewStampKey, { label: string; color: string; labelEm: number }> = {
  // Deep enough to stay legible over a scanned page, and WCAG-AA against white , 
  // t.colors.success (#10B981) fails that, same reasoning as WorkstationRail.
  reviewed: { label: 'REVIEWED', color: '#15803D', labelEm: 5.334 },
  approved: { label: 'APPROVED', color: '#1D4ED8', labelEm: 5.542 },
  // A mark only, like APPROVED: only REVIEWED sets the document's reviewed state.
  not_needed: { label: 'NOT NEEDED', color: '#4B5563', labelEm: 6.516 },
};

/** Review-stamp box, in PDF points. Sized to fit "NOT NEEDED" (the longest label) plus a date line. */
export const REVIEW_STAMP_SIZE = { width: 168, height: 46 };
/** Gap from the page's right and bottom edges. */
export const REVIEW_STAMP_MARGIN = 24;

/**
 * Review-stamp typography, as fractions of the box's DISPLAYED height. Single
 * source for the SVG overlay AND the pdf-lib flatten so the export matches the
 * on-screen stamp (they had already drifted ~20% apart before this was shared).
 * Baselines are measured y-up from the box bottom (the overlay converts to its
 * y-down SVG space).
 */
export const REVIEW_STAMP_TYPO = {
  labelSize: 0.42,
  whenSize: 0.2,
  labelBaseline: 0.5,
  whenBaseline: 0.22,
  /** Widest the label may run, as a fraction of the box's DISPLAYED width. */
  labelMaxWidth: 0.9,
} as const;

/** The on-screen stamp's face: Helvetica's metrics (Arial shares them), as the export draws. */
export const REVIEW_STAMP_FONT_FAMILY = 'Helvetica, Arial, sans-serif';

/**
 * Label font size for a review stamp box: its share of the box height, shrunk until the
 * label fits the box width. The box narrows with the page (reviewStampRect clamps it to the
 * page width), and a fixed size ran the longest label past the edges of a narrow page.
 * `widthAt1` is the label's width at size 1 in the font that draws it.
 */
export function reviewStampLabelSize(boxWidth: number, boxHeight: number, widthAt1: number): number {
  const preferred = boxHeight * REVIEW_STAMP_TYPO.labelSize;
  if (!(widthAt1 > 0)) return preferred;
  return Math.min(preferred, (boxWidth * REVIEW_STAMP_TYPO.labelMaxWidth) / widthAt1);
}

/**
 * `stampKey` state is widened to hold both stamp families, but `StampData.stamp`
 * stays narrowed to `StampKey`: this guard is what makes the compiler, rather
 * than a hand-written branch, stop a review key reaching a plain 'stamp' row.
 */
export function isReviewStampKey(k: StampKey | ReviewStampKey): k is ReviewStampKey {
  return k in REVIEW_STAMP_META;
}

/**
 * Bottom-right placement for a review stamp on a page of the given size.
 * Clamped at 0 so a page smaller than the stamp still yields an on-page box
 * rather than negative coordinates.
 */
export function reviewStampRect(
  pageWidthPt: number,
  pageHeightPt: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(REVIEW_STAMP_SIZE.width, pageWidthPt);
  const height = Math.min(REVIEW_STAMP_SIZE.height, pageHeightPt);
  return {
    x: round2(Math.max(0, pageWidthPt - width - REVIEW_STAMP_MARGIN)),
    y: round2(Math.max(0, REVIEW_STAMP_MARGIN)),
    width: round2(width),
    height: round2(height),
  };
}

/** The two lines drawn inside the box: the label, then when it was stamped. */
export function reviewStampLines(d: ReviewStampData): [string, string] {
  return [REVIEW_STAMP_META[d.stamp].label, formatDateTime(d.stampedAt)];
}

/** Excerpt length for a text note in the annotation list. */
const NOTE_EXCERPT_LEN = 40;

/**
 * Human label for one annotation, for the side panel. Pure so it is testable
 * without a PDF. A malformed `data` row degrades to its kind rather than
 * throwing: the panel must survive the same hand-edited jsonb that
 * `isAnnotationData` guards the renderer against.
 */
export function describeAnnotation(a: DocumentAnnotation): string {
  if (!isAnnotationData(a.kind, a.data)) return 'Mark';
  switch (a.kind) {
    case 'ink':
      // Same distinction the renderer makes: an opacity means it was drawn with
      // the freehand highlighter, not the pen.
      return (a.data as InkData).opacity === undefined ? 'Drawing' : 'Marker';
    case 'highlight':
      return 'Highlight';
    case 'text': {
      const text = (a.data as TextData).text.replace(/\s+/g, ' ').trim();
      if (text.length === 0) return 'Note';
      const excerpt =
        text.length > NOTE_EXCERPT_LEN ? `${text.slice(0, NOTE_EXCERPT_LEN)}…` : text;
      return `Note: “${excerpt}”`;
    }
    case 'stamp':
      return STAMP_META[(a.data as StampData).stamp].label;
    case 'review_stamp':
      return REVIEW_STAMP_META[(a.data as ReviewStampData).stamp].label;
    default:
      return 'Mark';
  }
}

// Rounding helper for storage: 2 decimals keeps jsonb compact; sub-point precision is invisible.
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveNum(v: unknown): v is number {
  return isFiniteNum(v) && v > 0;
}

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

function isFinitePair(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length === 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]);
}

// Read-side shape guard: jsonb is schemaless, so a hand-edited row must degrade
// to "skipped" (render + flatten both gate on this), never a crash.
export function isAnnotationData(kind: AnnotationKind, data: unknown): data is AnnotationData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  switch (kind) {
    case 'ink':
      return (
        Array.isArray(d.points) &&
        d.points.length >= 2 &&
        d.points.every(isFinitePair) &&
        isHexColor(d.color) &&
        isPositiveNum(d.width) &&
        // Optional: absent is the opaque-pen default. A present value must be a
        // real alpha: 0 would render an invisible stroke that still costs a row.
        (d.opacity === undefined || (isPositiveNum(d.opacity) && d.opacity <= 1))
      );
    case 'highlight':
      return (
        isFiniteNum(d.x) &&
        isFiniteNum(d.y) &&
        isFiniteNum(d.width) && d.width >= 0 &&
        isFiniteNum(d.height) && d.height >= 0 &&
        isHexColor(d.color)
      );
    case 'text':
      return (
        isFiniteNum(d.x) &&
        isFiniteNum(d.y) &&
        typeof d.text === 'string' &&
        d.text.length <= TEXT_MAX_LEN &&
        isHexColor(d.color) &&
        isPositiveNum(d.fontSize)
      );
    case 'stamp':
      return (
        isFiniteNum(d.x) &&
        isFiniteNum(d.y) &&
        isPositiveNum(d.size) &&
        typeof d.stamp === 'string' &&
        d.stamp in STAMP_META
      );
    case 'review_stamp':
      return (
        isFiniteNum(d.x) &&
        isFiniteNum(d.y) &&
        isPositiveNum(d.width) &&
        isPositiveNum(d.height) &&
        typeof d.stamp === 'string' &&
        d.stamp in REVIEW_STAMP_META &&
        // The timestamp is DRAWN, so an unparseable one would render "Invalid
        // Date" into a flattened PDF that goes out to a client.
        typeof d.stampedAt === 'string' &&
        Number.isFinite(Date.parse(d.stampedAt))
      );
    default:
      return false;
  }
}

export function svgPathFromPoints(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${round2(x)} ${round2(y)}`).join(' ');
}

// y-FLIPPED variant for pdf-lib drawSvgPath: pdf-lib interprets SVG paths y-down
// from the (x, y) anchor; callers anchor at { x: 0, y: pageHeightPt } so path
// coords must be (x, pageHeightPt − y).
export function pdfSvgPathFromPoints(points: [number, number][], pageHeightPt: number): string {
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${round2(x)} ${round2(pageHeightPt - y)}`)
    .join(' ');
}

// Any two drag corners → positive-size rect.
export function normalizeRect(
  a: [number, number],
  b: [number, number],
): { x: number; y: number; width: number; height: number } {
  return {
    x: round2(Math.min(a[0], b[0])),
    y: round2(Math.min(a[1], b[1])),
    width: round2(Math.abs(a[0] - b[0])),
    height: round2(Math.abs(a[1] - b[1])),
  };
}
