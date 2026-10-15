// Drawn-signature PNG validator, browser copy.
//
// The sign function runs the server copy (_shared/esign-signature-image.ts) on the same
// bytes; the two must stay byte-identical below this header. Here it only tells a signer
// what is wrong while they can still fix it: the server is the gate.
//
// It uses only web-standard APIs (atob, DecompressionStream), so the same file runs in the
// browser, in Deno and under vitest.
//
// SCOPE: structure, bounds and ink. It does NOT prove the image will embed: only pdf-lib
// can answer that, and an APNG passes every structural test here while pdf-lib refuses it.
// The sign function also trial-embeds the bytes. Both checks run BEFORE the signer row is
// marked signed, because signing expires the link before finalize runs: an image that
// validates but cannot be embedded would leave a row that is irreversibly signed and can
// never finalize.

/** Base64 characters accepted. Bounded before anything is decoded. */
export const MAX_SIGNATURE_IMAGE_BASE64_CHARS = 320_000;
export const MAX_SIGNATURE_IMAGE_WIDTH = 2400;
export const MAX_SIGNATURE_IMAGE_HEIGHT = 1000;
/**
 * Total pixels, checked from IHDR BEFORE inflating. This is the decompression
 * bomb guard: a 4096x4096 RGBA scanline stream deflates to roughly 65 KB and
 * inflates to roughly 67 MB, so bounding the request body bounds nothing.
 */
export const MAX_SIGNATURE_IMAGE_PIXELS = 1_200_000;
/** A stroke this thin is a stray tap, not a signature. */
export const MIN_SIGNATURE_INK_PIXELS = 40;
/** Alpha at or above this counts as "actually on the page". */
const INK_MIN_ALPHA = 128;
/**
 * Luminance at or below this counts as "dark enough to see". Alpha alone is not
 * enough: an all-opaque-WHITE image has a fully visible alpha channel, embeds
 * fine, and renders as nothing on a white page.
 */
const INK_MAX_LUMA = 200;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type SignatureImageRejection =
  | 'empty'
  | 'not_base64'
  | 'too_large'
  | 'not_png'
  // Covers a missing IHDR too: readChunks refuses the whole stream in that case.
  | 'bad_structure'
  | 'no_idat'
  | 'no_iend'
  | 'animated'
  | 'unsupported_format'
  | 'interlaced'
  | 'dimensions'
  | 'too_many_pixels'
  | 'too_much_data'
  | 'corrupt'
  | 'blank';

export type SignatureImageResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: SignatureImageRejection };

const fail = (reason: SignatureImageRejection): SignatureImageResult => ({ ok: false, reason });

/**
 * Strict base64 → bytes. Returns null on any malformed input.
 *
 * Exported because _shared/esign-pdf.ts needs the same decode to embed the
 * image, and two decoders that disagree about what is valid base64 is exactly
 * the divergence this repo keeps finding.
 */
export function decodeSignatureBase64(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const readU32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

interface PngChunks {
  ihdr: Uint8Array;
  sawTrns: boolean;
  // Explicitly backed by ArrayBuffer, not ArrayBufferLike: DecompressionStream's
  // writer takes BufferSource, and a SharedArrayBuffer-backed view is not one.
  idat: Uint8Array<ArrayBuffer>;
  sawIend: boolean;
  sawActl: boolean;
}

/**
 * Walk the chunk stream. Every length is validated against the remaining bytes,
 * so a truncated or lying chunk header can never read out of bounds.
 */
function readChunks(bytes: Uint8Array): PngChunks | null {
  let at = PNG_MAGIC.length;
  let ihdr: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let idatTotal = 0;
  let sawIend = false;
  let sawActl = false;
  let sawTrns = false;

  while (at + 8 <= bytes.length) {
    const len = readU32(bytes, at);
    // 4 length + 4 type + len data + 4 CRC
    if (len < 0 || at + 12 + len > bytes.length) return null;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const dataStart = at + 8;

    if (type === 'IHDR') {
      if (ihdr || len !== 13) return null;
      ihdr = bytes.subarray(dataStart, dataStart + 13);
    } else if (type === 'IDAT') {
      const part = bytes.subarray(dataStart, dataStart + len);
      idatParts.push(part);
      idatTotal += part.length;
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    } else if (type === 'acTL') {
      // APNG animation control. Structurally legal, and pdf-lib refuses it.
      sawActl = true;
    } else if (type === 'tRNS') {
      // Colour-key transparency. Illegal alongside a real alpha channel per the
      // PNG spec, so on the only colour type accepted below it can only be a
      // crafted input: and decoders that honour it disagree with a scan that
      // does not. See the rejection in the validator for why that matters.
      sawTrns = true;
    }

    at = dataStart + len + 4;
  }

  if (!ihdr) return null;
  const idat = new Uint8Array(idatTotal);
  let o = 0;
  for (const p of idatParts) {
    idat.set(p, o);
    o += p.length;
  }
  return { ihdr, idat, sawIend, sawActl, sawTrns };
}

/** Signals that inflation was abandoned because it exceeded the cap. */
export const OVER_CAP = 'over_cap';

/**
 * Inflate, refusing to buffer more than `cap` bytes. PNG IDAT is a zlib stream
 * (RFC 1950), which is what the Compression Streams API calls 'deflate' :
 * 'deflate-raw' would be wrong here.
 *
 * Returns OVER_CAP (not null) when the cap is hit, so the caller can report
 * "too much data" separately from "undecodable". They are different failures
 * and, more practically, a shared return value let this guard and the
 * scanline-length check below mask each other: with either one removed the
 * result was still a rejection, so neither was actually under test.
 *
 * Exported for direct testing: a bomb's rejection cannot be distinguished from
 * a size-check rejection through the public entry point alone.
 */
export async function inflateCapped(
  data: Uint8Array<ArrayBuffer>,
  cap: number,
): Promise<Uint8Array | typeof OVER_CAP | null> {
  try {
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    // Not awaited: the write must proceed concurrently with the reads below, or
    // anything larger than the internal queue deadlocks. The trailing catch is
    // load-bearing: on corrupt input the writable side errors, and a rejection
    // handler passed to .then() covers write() but NOT the close() it returns.
    void writer
      .write(data)
      .then(() => writer.close())
      .catch(() => {});
    const reader = stream.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return OVER_CAP;
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  } catch {
    return null;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverse the five PNG scanline filters. Inflating IDAT yields FILTERED
 * scanlines, not pixels: without this the ink check would be reading noise.
 * Assumes non-interlaced (Adam7 lays bytes out entirely differently), which the
 * IHDR check above guarantees.
 *
 * Exported for direct testing: a wrong Paeth predictor still reconstructs a
 * uniform image correctly, so this is only genuinely under test when compared
 * byte-for-byte against known pixels.
 */
export function unfilterScanlines(
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array | null {
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) return null;
  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[pos];
      pos += 1;
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: val = cur + paeth(a, b, c); break;
        default: return null;
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  return out;
}

/**
 * Validate a base64 PNG produced by the signature pad.
 *
 * Four ordered stages, cheapest and most bounding first:
 *   1. base64 shape and length, magic bytes, chunk walk
 *   2. IHDR bounds (dimensions, pixel count, colour format, interlace),
 *      BEFORE anything is inflated
 *   3. inflate, capped at exactly the size the header implies
 *   4. unfilter and count ink (opaque AND dark)
 *
 * The trial pdf-lib embed is not here: it runs on the server, where pdf-lib is.
 */
export async function validateSignatureImageBase64(input: unknown): Promise<SignatureImageResult> {
  if (typeof input !== 'string' || input.length === 0) return fail('empty');
  if (input.length > MAX_SIGNATURE_IMAGE_BASE64_CHARS) return fail('too_large');

  const bytes = decodeSignatureBase64(input);
  if (!bytes) return fail('not_base64');
  if (bytes.length < PNG_MAGIC.length) return fail('not_png');
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC[i]) return fail('not_png');
  }

  const chunks = readChunks(bytes);
  if (!chunks) return fail('bad_structure');
  if (chunks.sawActl) return fail('animated');
  // A tRNS chunk defines transparency OUTSIDE the pixel data. An RGB image whose
  // every pixel is black plus a tRNS entry making black transparent scans as
  // solid ink here and decodes to nothing in pdf-lib: a blank signature on a
  // legal document, accepted and irreversibly signed. Refused outright rather
  // than interpreted: the pad never emits one.
  if (chunks.sawTrns) return fail('unsupported_format');
  if (!chunks.sawIend) return fail('no_iend');
  if (chunks.idat.length === 0) return fail('no_idat');

  const { ihdr } = chunks;
  const width = readU32(ihdr, 0);
  const height = readU32(ihdr, 4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];

  if (width < 1 || height < 1) return fail('dimensions');
  if (width > MAX_SIGNATURE_IMAGE_WIDTH || height > MAX_SIGNATURE_IMAGE_HEIGHT) return fail('dimensions');
  if (width * height > MAX_SIGNATURE_IMAGE_PIXELS) return fail('too_many_pixels');
  if (compression !== 0 || filterMethod !== 0) return fail('unsupported_format');
  if (interlace !== 0) return fail('interlaced');
  // 8-bit RGBA (colour type 6) ONLY: exactly what canvas toDataURL('image/png')
  // emits for the pad. RGB (2) was accepted at one point "so an opaque-canvas
  // variant does not hard-fail"; nothing produces that, and allowing it opened
  // the tRNS hole above, because a channel-less alpha has to be modelled from
  // somewhere. A format the product cannot generate is not worth the decoder
  // surface it costs.
  if (bitDepth !== 8) return fail('unsupported_format');
  if (colorType !== 6) return fail('unsupported_format');

  const bpp = 4;
  // A valid PNG inflates to EXACTLY one filter byte plus one scanline per row,
  // so the header's own numbers are the tightest possible cap. Anything larger
  // is a bomb or a lie, and is abandoned mid-stream rather than buffered.
  const expected = height * (width * bpp + 1);
  const raw = await inflateCapped(chunks.idat, expected);
  if (raw === OVER_CAP) return fail('too_much_data');
  if (!raw) return fail('corrupt');

  const pixels = unfilterScanlines(raw, width, height, bpp);
  if (!pixels) return fail('corrupt');

  let inkFound = 0;
  for (let i = 0; i < pixels.length; i += bpp) {
    const alpha = pixels[i + 3];
    if (alpha < INK_MIN_ALPHA) continue;
    // Rec. 601 luma, integer arithmetic.
    const luma = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
    if (luma <= INK_MAX_LUMA) {
      inkFound += 1;
      if (inkFound >= MIN_SIGNATURE_INK_PIXELS) break;
    }
  }
  if (inkFound < MIN_SIGNATURE_INK_PIXELS) return fail('blank');

  return { ok: true, width, height };
}
