import type { PDFImage } from 'pdf-lib';
import { PDFJS_MAX_IMAGE_SIZE } from '@/lib/pdfjsAssetPaths';

/**
 * Wrap a PNG or JPEG in a one-page PDF so the annotation stack (pdfjs render,
 * marks stored in PDF page points, pdf-lib flatten on Export/Save) runs on an
 * image unchanged. Nothing is written back: the wrapped bytes live only in the
 * open workstation, and an annotated image exports as a PDF.
 *
 * The page size is a pure function of the image, so the same file always
 * wraps to the same page and saved marks land where they were placed.
 */

export type WrappableImage = 'png' | 'jpeg';

/** Long side of the wrapped page, in points (11 in). Stamps and pen widths are
 * sized in points, so a 4000 px phone photo and a 300 px scan both read at
 * letter-page scale instead of the stamp shrinking or ballooning. */
export const IMAGE_PAGE_LONG_SIDE_PT = 792;

export function sniffWrappableImage(bytes: Uint8Array): WrappableImage | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/**
 * EXIF orientation (tag 0x0112) of a JPEG, 1 when absent or unreadable.
 * Browsers honour it in `<img>`, so the wrapped page must too, or a phone
 * photo that previews upright stamps sideways.
 */
export function jpegExifOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    // Start of scan: no metadata past this point.
    if (marker === 0xda) return 1;
    const segmentLength = view.getUint16(offset + 2);
    if (marker === 0xe1 && segmentLength >= 16) {
      const start = offset + 4;
      const isExif =
        bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66;
      // The segment length is the file's claim; never read past the real bytes.
      if (isExif) return readTiffOrientation(view, start + 6, Math.min(offset + 2 + segmentLength, bytes.length));
    }
    offset += 2 + segmentLength;
  }
  return 1;
}

/**
 * True when the JPEG reaches a start-of-scan segment with bytes after it. A
 * file that ends before any scan has no pixels: pdf-lib would wrap it happily
 * and pdf.js would paint an empty page.
 */
export function jpegHasScan(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    const segmentEnd = offset + 2 + view.getUint16(offset + 2);
    if (bytes[offset + 1] === 0xda) return segmentEnd < bytes.length;
    offset = segmentEnd;
  }
  return false;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

export interface Placement {
  pageWidth: number;
  pageHeight: number;
  x: number;
  y: number;
  rotate: number;
  /** Signed: a negative width or height mirrors the image on that axis. */
  width: number;
  height: number;
}

/**
 * Where to draw a `w` x `h` (already scaled) image so it appears as a browser
 * shows it for EXIF orientation `orientation`, all eight of them. pdf-lib's
 * drawImage is translate(x, y), then rotate (degrees, counter-clockwise), then
 * scale(width, height), so a signed scale carries the mirrored orientations.
 */
export function orientedPlacement(w: number, h: number, orientation: number): Placement {
  switch (orientation) {
    case 2:
      return { pageWidth: w, pageHeight: h, x: w, y: 0, rotate: 0, width: -w, height: h };
    case 3:
      return { pageWidth: w, pageHeight: h, x: w, y: h, rotate: 180, width: w, height: h };
    case 4:
      return { pageWidth: w, pageHeight: h, x: 0, y: h, rotate: 0, width: w, height: -h };
    case 5:
      return { pageWidth: h, pageHeight: w, x: h, y: w, rotate: -90, width: w, height: -h };
    case 6:
      return { pageWidth: h, pageHeight: w, x: 0, y: w, rotate: -90, width: w, height: h };
    case 7:
      return { pageWidth: h, pageHeight: w, x: 0, y: 0, rotate: 90, width: w, height: -h };
    case 8:
      return { pageWidth: h, pageHeight: w, x: h, y: 0, rotate: 90, width: w, height: h };
    default:
      return { pageWidth: w, pageHeight: h, x: 0, y: 0, rotate: 0, width: w, height: h };
  }
}

/**
 * Pixel ceiling for a PNG, checked from its header BEFORE pdf-lib decodes it.
 * pdf-lib inflates a PNG to RGBA plus separate RGB and alpha copies (~8 bytes a
 * pixel), so a small file declaring huge dimensions would exhaust the tab before
 * pdf.js's own `maxImageSize` is ever consulted. 16 MP is a 4000 x 4000 scan.
 * JPEGs are not decoded here (pdf-lib copies them through), but pdf.js SKIPS an
 * image over its own maxImageSize and paints a blank page, so a JPEG over that
 * ceiling is refused below instead.
 */
export const MAX_WRAP_PNG_PIXELS = 16_000_000;

/** Width x height from a PNG's IHDR chunk, or null if the header is not there. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR is always the first chunk: length(4) 'IHDR'(4) width(4) height(4).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function wrapImageAsPdf(bytes: Uint8Array, kind: WrappableImage): Promise<Uint8Array> {
  // Dynamic import for bundle isolation, same as flattenAnnotations.
  if (kind === 'png') {
    const dims = pngDimensions(bytes);
    if (!dims || dims.width * dims.height > MAX_WRAP_PNG_PIXELS) throw new Error('image-too-large');
  } else if (!jpegHasScan(bytes)) {
    throw new Error('no-image-data');
  }
  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const image: PDFImage = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  if (image.width <= 0 || image.height <= 0) throw new Error('empty-image');
  if (image.width * image.height > PDFJS_MAX_IMAGE_SIZE) throw new Error('image-too-large');

  const scale = IMAGE_PAGE_LONG_SIDE_PT / Math.max(image.width, image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const orientation = kind === 'jpeg' ? jpegExifOrientation(bytes) : 1;
  const p = orientedPlacement(w, h, orientation);

  const page = pdf.addPage([p.pageWidth, p.pageHeight]);
  page.drawImage(image, { x: p.x, y: p.y, width: p.width, height: p.height, rotate: degrees(p.rotate) });
  return pdf.save();
}
