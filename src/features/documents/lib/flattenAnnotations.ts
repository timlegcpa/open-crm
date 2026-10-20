import type { PDFFont, PDFPage } from 'pdf-lib';
import {
  HIGHLIGHT_OPACITY,
  REVIEW_STAMP_META,
  REVIEW_STAMP_TYPO,
  reviewStampLabelSize,
  STAMP_META,
  isAnnotationData,
  pdfSvgPathFromPoints,
  reviewStampLines,
  type DocumentAnnotation,
  type HighlightData,
  type InkData,
  type ReviewStampData,
  type StampData,
  type TextData,
} from './annotations';

// Stroke width for stamp glyphs, in 24-box path units: the drawSvgPath `scale`
// cm transform scales it with the glyph.
const STAMP_STROKE_WIDTH = 2;

// Anchor offset (in box sizes, from the stamp box's bottom-left (x, y)) per
// normalized page /Rotate. drawSvgPath applies translate → rotate → y-down scale,
// so a path point p maps to anchor + R(θ)·(px·s, −py·s); the image of the
// [0..s]×[0..s] path box therefore spans, relative to the anchor:
//    0°: [0..s]×[−s..0]  → anchor at box top-left     (x,     y + s)
//   90°: [0..s]×[0..s]   → anchor at box bottom-left  (x,     y)
//  180°: [−s..0]×[0..s]  → anchor at box bottom-right (x + s, y)
//  270°: [−s..0]×[−s..0] → anchor at box top-right    (x + s, y + s)
// This keeps the drawn glyph inside the exact [x, x+size]×[y, y+size] box the
// overlay shows, while the rotate makes it read upright on the displayed page
// (same compensation idea as the rotation-aware text-drawing path further below).
const STAMP_ANCHOR_OFFSET: Record<number, [number, number]> = {
  0: [0, 1],
  90: [0, 0],
  180: [1, 0],
  270: [1, 1],
};

// Review-stamp rotation tables. The stored rect is axis-aligned in UNROTATED
// space (the overlay renders it as-is), so the box outline never rotates: only
// the text does, to read upright on the displayed page. Per normalized /Rotate:
// which corner of the stored rect is the DISPLAYED bottom-left (fractions of
// width/height), and the displayed right/up unit vectors in unrotated coords.
// Same rotational family as STAMP_ANCHOR_OFFSET above.
const REVIEW_CORNER_OFFSET: Record<number, [number, number]> = {
  0: [0, 0],
  90: [1, 0],
  180: [1, 1],
  270: [0, 1],
};
const ROT_RIGHT: Record<number, [number, number]> = {
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
};
const ROT_UP: Record<number, [number, number]> = {
  0: [0, 1],
  90: [-1, 0],
  180: [0, -1],
  270: [1, 0],
};

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

// Space available along the text baseline (which follows the page's /Rotate so
// glyphs read upright): 0° runs +x, 90° runs +y, 180° runs −x, 270° runs −y.
function textAvailAlongBaseline(page: PDFPage, x: number, y: number, angle: number): number {
  if (angle === 90) return page.getHeight() - y;
  if (angle === 180) return x;
  if (angle === 270) return y;
  return page.getWidth() - x;
}

export async function flattenAnnotatedPdf(
  originalBytes: Uint8Array,
  annotations: DocumentAnnotation[],
): Promise<Uint8Array> {
  // Dynamic import for bundle isolation: pdf-lib must stay out of the entry chunk.
  const { PDFDocument, StandardFonts, rgb, degrees, EncryptedPDFError, LineCapStyle, BlendMode } =
    await import('pdf-lib');

  const pdf = await PDFDocument.load(originalBytes).catch((err: unknown) => {
    // pdf-lib 1.17.1's ES5/tslib build (`_super.call(this, msg) || this`) throws a
    // plain Error whose prototype is NOT EncryptedPDFError, so instanceof alone can
    // never match at runtime (verified against both cjs and es builds). Keep the
    // instanceof probe for a future fixed build; fall back to the class's fixed
    // message. Corrupted files rethrow untouched: the UI shows different copy.
    const encrypted =
      err instanceof EncryptedPDFError ||
      (err instanceof Error && err.message.includes('`PDFDocument.load` is encrypted'));
    if (encrypted) throw new Error('encrypted-pdf');
    throw err;
  });

  try {
    const form = pdf.getForm();
    if (form.getFields().length > 0) form.flatten();
  } catch {
    // Malformed AcroForm: continue without flattening rather than fail the export
    // (esign-pdf.ts precedent).
  }

  const pages = pdf.getPages();
  let helvetica: PDFFont | null = null;
  let helveticaChars: Set<number> | null = null;

  for (const ann of annotations) {
    if (ann.page_index < 0 || ann.page_index >= pages.length) continue;
    if (!isAnnotationData(ann.kind, ann.data)) continue;
    const page = pages[ann.page_index];

    if (ann.kind === 'highlight') {
      const d = ann.data as HighlightData;
      const c = hexToRgb01(d.color);
      page.drawRectangle({
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
        color: rgb(c.r, c.g, c.b),
        opacity: HIGHLIGHT_OPACITY,
        borderWidth: 0,
      });
    } else if (ann.kind === 'ink') {
      const d = ann.data as InkData;
      const pageH = page.getHeight();
      const c = hexToRgb01(d.color);
      // `opacity` present ⇒ freehand highlighter (see InkData). Multiply is what
      // keeps text under a 22pt marker readable: plain alpha washes it out , 
      // and round caps stop a wide stroke showing notches at every vertex.
      const isMarker = d.opacity !== undefined;
      page.drawSvgPath(pdfSvgPathFromPoints(d.points, pageH), {
        x: 0,
        y: pageH,
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: d.width,
        borderOpacity: d.opacity ?? 1,
        borderLineCap: LineCapStyle.Round,
        ...(isMarker ? { blendMode: BlendMode.Multiply } : {}),
      });
    } else if (ann.kind === 'text') {
      const d = ann.data as TextData;
      if (helvetica === null || helveticaChars === null) {
        helvetica = await pdf.embedFont(StandardFonts.Helvetica);
        helveticaChars = new Set(helvetica.getCharacterSet());
      }
      const chars = helveticaChars;
      // Strip characters outside WinAnsi (one emoji must not throw the whole
      // flatten); keep \n: drawText handles line breaks itself.
      const text = Array.from(d.text)
        .filter((ch) => ch === '\n' || chars.has(ch.codePointAt(0) as number))
        .join('');
      if (text.length === 0) continue;
      const angle = normalizeAngle(page.getRotation().angle);
      // Clamp to a sane floor: a near-edge click on a rotated page must not yield
      // a tiny/negative maxWidth, which pdf-lib can throw on.
      const maxWidth = Math.max(72, textAvailAlongBaseline(page, d.x, d.y, angle) - 8);
      const c = hexToRgb01(d.color);
      page.drawText(text, {
        x: d.x,
        y: d.y,
        size: d.fontSize,
        font: helvetica,
        color: rgb(c.r, c.g, c.b),
        rotate: degrees(angle),
        maxWidth,
        lineHeight: d.fontSize * 1.25,
      });
    } else if (ann.kind === 'review_stamp') {
      const d = ann.data as ReviewStampData;
      const meta = REVIEW_STAMP_META[d.stamp];
      const c = hexToRgb01(meta.color);
      const angle = normalizeAngle(page.getRotation().angle);
      if (helvetica === null || helveticaChars === null) {
        helvetica = await pdf.embedFont(StandardFonts.Helvetica);
        helveticaChars = new Set(helvetica.getCharacterSet());
      }
      const chars = helveticaChars;
      const font = helvetica;
      // Box: axis-aligned exactly as stored: rotating it about (x, y) drew a
      // different rect than the overlay on /Rotate pages. White backing matches
      // the overlay (fill white @ .75) so the stamp stays legible over scans.
      page.drawRectangle({
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
        color: rgb(1, 1, 1),
        opacity: 0.75,
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: 2,
      });
      // Displayed box dims swap on sideways pages; type fractions are the shared
      // REVIEW_STAMP_TYPO so the export matches the on-screen stamp.
      const sideways = angle === 90 || angle === 270;
      const boxW = sideways ? d.height : d.width;
      const boxH = sideways ? d.width : d.height;
      const [cx, cy] = REVIEW_CORNER_OFFSET[angle] ?? REVIEW_CORNER_OFFSET[0];
      const [ux, uy] = ROT_RIGHT[angle] ?? ROT_RIGHT[0];
      const [vx, vy] = ROT_UP[angle] ?? ROT_UP[0];
      const originX = d.x + cx * d.width;
      const originY = d.y + cy * d.height;
      const drawLine = (raw: string, size: number, baselineFrac: number) => {
        // Same WinAnsi guard as the text branch: formatDateTime emits U+202F
        // before AM/PM on some ICU versions, and one unencodable character
        // would throw the whole flatten.
        const text = Array.from(raw.replace(/[\u202F\u00A0]/g, ' '))
          .filter((ch) => chars.has(ch.codePointAt(0) as number))
          .join('');
        if (text.length === 0) return;
        // Centred by measured width so the line sits in the box at any size;
        // offsets run along the DISPLAYED axes so rotated text stays inside.
        const dx = (boxW - font.widthOfTextAtSize(text, size)) / 2;
        const dy = boxH * baselineFrac;
        page.drawText(text, {
          x: originX + ux * dx + vx * dy,
          y: originY + uy * dx + vy * dy,
          size,
          font,
          color: rgb(c.r, c.g, c.b),
          rotate: degrees(angle),
        });
      };
      const [label, when] = reviewStampLines(d);
      // Shrunk to the box on a narrow page, by the label's measured width in this font.
      drawLine(label, reviewStampLabelSize(boxW, boxH, font.widthOfTextAtSize(label, 1)), REVIEW_STAMP_TYPO.labelBaseline);
      drawLine(when, boxH * REVIEW_STAMP_TYPO.whenSize, REVIEW_STAMP_TYPO.whenBaseline);
    } else if (ann.kind === 'stamp') {
      // Explicit, NOT a trailing `else`: a bare else would cast a future kind to
      // StampData and read STAMP_META[undefined]. An unhandled kind must draw
      // nothing at all.
      const d = ann.data as StampData;
      const meta = STAMP_META[d.stamp];
      const c = hexToRgb01(meta.color);
      // (x, y) is the stamp box's bottom-left corner; the 24-box path is y-down.
      // The anchor is rotation-dependent (see STAMP_ANCHOR_OFFSET) so the glyph
      // fills the same box regardless of page /Rotate; `scale` maps 24 → size.
      const angle = normalizeAngle(page.getRotation().angle);
      const [ox, oy] = STAMP_ANCHOR_OFFSET[angle] ?? STAMP_ANCHOR_OFFSET[0];
      page.drawSvgPath(meta.path, {
        x: d.x + ox * d.size,
        y: d.y + oy * d.size,
        scale: d.size / 24,
        rotate: degrees(angle),
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: STAMP_STROKE_WIDTH,
        borderOpacity: 1,
      });
    }
  }

  return pdf.save();
}
