import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  IMAGE_PAGE_LONG_SIDE_PT,
  MAX_WRAP_PNG_PIXELS,
  jpegExifOrientation,
  type Placement,
  orientedPlacement,
  sniffWrappableImage,
  wrapImageAsPdf,
} from '../lib/imageToPdf';

/** A real (decodable) RGB PNG of the given size, built here so the test needs no image file. */
function makePng(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set([...type].map((ch) => ch.charCodeAt(0)), 0);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const raw = new Uint8Array(height * (1 + width * 3)); // filter byte 0 + black pixels per row
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}

/** A header-only JPEG: SOI, optional EXIF orientation, SOF0 with the given size, EOI.
 * pdf-lib's JPEG embedder reads dimensions from SOF and never decodes pixels. */
function syntheticJpeg(
  width: number,
  height: number,
  orientation?: number,
  littleEndian = false,
  withScan = true,
): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
    const u32 = (v: number) =>
      littleEndian
        ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
        : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const tiff = [
      ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
      ...u32(0),
    ];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    out.push(0xff, 0xe1, len >> 8, len & 0xff, ...payload);
  }
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03);
  out.push(0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00);
  // Start of scan plus a few entropy-coded bytes: pdf-lib only copies them through.
  if (withScan) out.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00, 0x00);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

async function pageSize(pdfBytes: Uint8Array): Promise<{ width: number; height: number; count: number }> {
  const pdf = await PDFDocument.load(pdfBytes);
  const { width, height } = pdf.getPage(0).getSize();
  return { width, height, count: pdf.getPageCount() };
}

describe('sniffWrappableImage', () => {
  it('names PNG and JPEG by their magic bytes and nothing else', () => {
    expect(sniffWrappableImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffWrappableImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffWrappableImage(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(sniffWrappableImage(new Uint8Array([]))).toBeNull();
  });
});

describe('jpegExifOrientation', () => {
  it('reads the orientation tag in both byte orders', () => {
    expect(jpegExifOrientation(syntheticJpeg(40, 30, 6))).toBe(6);
    expect(jpegExifOrientation(syntheticJpeg(40, 30, 8, true))).toBe(8);
  });
  it('is 1 when there is no EXIF block', () => {
    expect(jpegExifOrientation(syntheticJpeg(40, 30))).toBe(1);
  });
});

/** Where pdf-lib's drawImage (translate, rotate, scale) sends a point of the
 * image's unit square, (0,0) = stored bottom-left, (0,1) = stored top-left. */
function mapPoint(p: Placement, u: number, v: number): [number, number] {
  const r = (p.rotate * Math.PI) / 180;
  const sx = p.width * u;
  const sy = p.height * v;
  return [p.x + sx * Math.cos(r) - sy * Math.sin(r), p.y + sx * Math.sin(r) + sy * Math.cos(r)].map(
    (n) => Math.round(n * 1e6) / 1e6 + 0,
  ) as [number, number];
}

describe('orientedPlacement', () => {
  const w = 400;
  const h = 300;
  // Where the stored image's top-left pixel must appear on the page, per the
  // EXIF definitions (2 mirror, 3 half turn, 4 flip, 5 transpose, 6 quarter
  // turn clockwise, 7 transverse, 8 quarter turn counter-clockwise).
  const topLeftLandsAt: Record<number, 'tl' | 'tr' | 'br' | 'bl'> = {
    1: 'tl', 2: 'tr', 3: 'br', 4: 'bl', 5: 'tl', 6: 'tr', 7: 'br', 8: 'bl',
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('orientation %i fills the page and puts the top-left pixel in place', (o) => {
    const p = orientedPlacement(w, h, o);
    const quarterTurn = o >= 5;
    expect([p.pageWidth, p.pageHeight]).toEqual(quarterTurn ? [h, w] : [w, h]);

    const corners = [mapPoint(p, 0, 0), mapPoint(p, 1, 0), mapPoint(p, 0, 1), mapPoint(p, 1, 1)];
    expect(new Set(corners.map((c) => c.join(',')))).toEqual(
      new Set([`0,0`, `${p.pageWidth},0`, `0,${p.pageHeight}`, `${p.pageWidth},${p.pageHeight}`]),
    );

    const expected = {
      tl: [0, p.pageHeight],
      tr: [p.pageWidth, p.pageHeight],
      br: [p.pageWidth, 0],
      bl: [0, 0],
    }[topLeftLandsAt[o]];
    expect(mapPoint(p, 0, 1)).toEqual(expected);
  });

  it('treats a missing or unknown orientation as upright', () => {
    expect(orientedPlacement(w, h, 0)).toEqual(orientedPlacement(w, h, 1));
  });
});

describe('wrapImageAsPdf', () => {
  it('wraps a PNG in one page whose long side is the fixed page size', async () => {
    const png = makePng(40, 20);
    const size = await pageSize(await wrapImageAsPdf(png, 'png'));
    expect(size.count).toBe(1);
    expect(Math.max(size.width, size.height)).toBeCloseTo(IMAGE_PAGE_LONG_SIDE_PT, 3);
  });

  it('refuses a PNG whose header declares more pixels than the ceiling, before decoding it', async () => {
    const side = Math.ceil(Math.sqrt(MAX_WRAP_PNG_PIXELS)) + 1;
    const header = new Uint8Array(33);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(header.buffer).setUint32(16, side);
    new DataView(header.buffer).setUint32(20, side);
    // No image data follows, so reaching pdf-lib would fail with a different error.
    await expect(wrapImageAsPdf(header, 'png')).rejects.toThrow('image-too-large');
  });

  it('refuses a JPEG that ends before any image scan', async () => {
    await expect(wrapImageAsPdf(syntheticJpeg(4000, 3000, undefined, false, false), 'jpeg')).rejects.toThrow(
      'no-image-data',
    );
  });

  it('refuses a JPEG over the pdf.js image ceiling, which would paint a blank page', async () => {
    // 10000 x 7000 = 70 MP, over the 64 MP maxImageSize.
    await expect(wrapImageAsPdf(syntheticJpeg(10000, 7000), 'jpeg')).rejects.toThrow('image-too-large');
  });

  it('lays a landscape JPEG on a landscape page', async () => {
    const size = await pageSize(await wrapImageAsPdf(syntheticJpeg(4000, 3000), 'jpeg'));
    expect(size.width).toBeCloseTo(792, 3);
    expect(size.height).toBeCloseTo(594, 3);
  });

  it('stands a sideways phone photo upright (EXIF 6)', async () => {
    const size = await pageSize(await wrapImageAsPdf(syntheticJpeg(4000, 3000, 6), 'jpeg'));
    expect(size.width).toBeCloseTo(594, 3);
    expect(size.height).toBeCloseTo(792, 3);
  });

  it('draws the mirrored orientations without pdf-lib refusing a signed size', async () => {
    for (const o of [2, 4, 5, 7]) {
      const size = await pageSize(await wrapImageAsPdf(syntheticJpeg(4000, 3000, o), 'jpeg'));
      expect(size.count).toBe(1);
    }
  });
});
