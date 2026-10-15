// @vitest-environment node
// The drawn-signature validator (ported with its fixtures), then esign-signer-sign.
// Tests for the drawn-signature PNG validator.
//
// Every fixture here is a REAL PNG built byte by byte (correct CRCs, real zlib
// IDAT), not a hand-waved blob — otherwise "rejected" would prove nothing about
// why it was rejected.
//
// The two blank cases (fully transparent, and fully opaque WHITE) are the ones
// worth reading first: both are things the design asserted it handled at a point
// when it did not, and the second is why the ink check tests darkness and not
// just alpha.

import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_SIGNATURE_IMAGE_BASE64_CHARS,
  MAX_SIGNATURE_IMAGE_HEIGHT,
  MAX_SIGNATURE_IMAGE_PIXELS,
  MAX_SIGNATURE_IMAGE_WIDTH,
  MIN_SIGNATURE_INK_PIXELS,
  OVER_CAP,
  inflateCapped,
  unfilterScanlines,
  validateSignatureImageBase64,
} from '../../../supabase/functions/esign-finalize-envelope/lib/signature-image';
import { createSignerSignHandler, type SignerSignDeps } from '../../../supabase/functions/esign-signer-sign/handler';
import { describeEdgeContract, edgeRequest, throwInternal } from './contract';
import { createWorld, drawnSignaturePng, openSession, ORIGINS, pdfTools, seedContact, seedSentEnvelope, SIGNER_IP, type World } from './esign-world';

// ── PNG construction ───────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function chunk(type: string, data: Uint8Array): number[] {
  const typeBytes = [...type].map((ch) => ch.charCodeAt(0));
  const crcInput = new Uint8Array([...typeBytes, ...data]);
  return [...u32(data.length), ...typeBytes, ...data, ...u32(crc32(crcInput))];
}

const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ihdrData(o: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
}): Uint8Array {
  return new Uint8Array([
    ...u32(o.width),
    ...u32(o.height),
    o.bitDepth ?? 8,
    o.colorType ?? 6,
    0,
    0,
    o.interlace ?? 0,
  ]);
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

/** Apply a PNG scanline filter so the validator's unfilterer has real work to do. */
function filterScanlines(pixels: Uint8Array, width: number, height: number, bpp: number, filter: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    out[o] = filter;
    o += 1;
    for (let x = 0; x < stride; x += 1) {
      const cur = pixels[y * stride + x];
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 1: v = cur - a; break;
        case 2: v = cur - b; break;
        case 3: v = cur - ((a + b) >> 1); break;
        case 4: v = cur - paeth(a, b, c); break;
        default: v = cur;
      }
      out[o] = v & 0xff;
      o += 1;
    }
  }
  return out;
}

interface PngOpts {
  width: number;
  height: number;
  pixels?: Uint8Array;
  colorType?: number;
  bitDepth?: number;
  interlace?: number;
  filter?: number;
  /** Raw (already-deflated) IDAT payload, bypassing pixel encoding. */
  rawIdat?: Uint8Array;
  omitIdat?: boolean;
  omitIend?: boolean;
  extraChunks?: Array<{ type: string; data: Uint8Array }>;
}

function buildPng(o: PngOpts): Uint8Array {
  const bpp = (o.colorType ?? 6) === 6 ? 4 : 3;
  const bytes: number[] = [...MAGIC];
  bytes.push(...chunk('IHDR', ihdrData(o)));
  for (const extra of o.extraChunks ?? []) bytes.push(...chunk(extra.type, extra.data));
  if (!o.omitIdat) {
    const idat =
      o.rawIdat ??
      new Uint8Array(
        deflateSync(
          Buffer.from(
            filterScanlines(
              o.pixels ?? new Uint8Array(o.width * o.height * bpp),
              o.width,
              o.height,
              bpp,
              o.filter ?? 0,
            ),
          ),
        ),
      );
    bytes.push(...chunk('IDAT', idat));
  }
  if (!o.omitIend) bytes.push(...chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(bytes);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** A transparent canvas with a dark stroke drawn across it — what the pad emits. */
function signaturePixels(width: number, height: number, inkPixels: number): Uint8Array {
  const px = new Uint8Array(width * height * 4); // all zero = fully transparent
  for (let i = 0; i < inkPixels; i += 1) {
    const at = i * 4;
    px[at] = 0x1a;
    px[at + 1] = 0x1a;
    px[at + 2] = 0x1a;
    px[at + 3] = 0xff;
  }
  return px;
}

const signaturePng = (width = 60, height = 20, ink = MIN_SIGNATURE_INK_PIXELS + 10): Uint8Array =>
  buildPng({ width, height, pixels: signaturePixels(width, height, ink) });

// ── Accept ─────────────────────────────────────────────────────────────────

describe('validateSignatureImageBase64 — accepts', () => {
  it('a genuine pad-shaped signature', async () => {
    const res = await validateSignatureImageBase64(b64(signaturePng()));
    expect(res).toEqual({ ok: true, width: 60, height: 20 });
  });

  // The unfilterer is only as good as its worst filter type: a wrong Paeth
  // reverses into noise, and noise happens to contain dark pixels — so a broken
  // unfilterer would ACCEPT a blank image rather than reject a good one.
  it.each([0, 1, 2, 3, 4])('reconstructs scanlines under filter type %i', async (filter) => {
    const png = buildPng({
      width: 60,
      height: 20,
      pixels: signaturePixels(60, 20, MIN_SIGNATURE_INK_PIXELS + 10),
      filter,
    });
    const res = await validateSignatureImageBase64(b64(png));
    expect(res.ok).toBe(true);
  });

  it('reports blank for a filtered image whose reconstruction is genuinely empty', async () => {
    // Same filters, zero ink: proves the filter cases above pass because the
    // pixels really are dark, not because filtering fabricates darkness.
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = buildPng({ width: 60, height: 20, filter });
      const res = await validateSignatureImageBase64(b64(png));
      expect(res).toEqual({ ok: false, reason: 'blank' });
    }
  });
});

// ── Reject ─────────────────────────────────────────────────────────────────

describe('validateSignatureImageBase64 — rejects', () => {
  it.each([
    ['a non-string', 123],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('%s', async (_label, input) => {
    expect(await validateSignatureImageBase64(input)).toEqual({ ok: false, reason: 'empty' });
  });

  it('non-base64 characters', async () => {
    expect(await validateSignatureImageBase64('not*valid*base64')).toEqual({ ok: false, reason: 'not_base64' });
  });

  it('base64 of the wrong length', async () => {
    expect(await validateSignatureImageBase64('abcde')).toEqual({ ok: false, reason: 'not_base64' });
  });

  it('an oversized payload before decoding it', async () => {
    const huge = 'A'.repeat(MAX_SIGNATURE_IMAGE_BASE64_CHARS + 4);
    expect(await validateSignatureImageBase64(huge)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('a non-PNG (wrong magic bytes)', async () => {
    const jpegish = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(await validateSignatureImageBase64(b64(jpegish))).toEqual({ ok: false, reason: 'not_png' });
  });

  it('a truncated PNG (chunk length runs past the buffer)', async () => {
    const full = signaturePng();
    const cut = full.subarray(0, full.length - 30);
    expect(await validateSignatureImageBase64(b64(cut))).toEqual({ ok: false, reason: 'bad_structure' });
  });

  it('a PNG with no IEND', async () => {
    const png = buildPng({ width: 60, height: 20, pixels: signaturePixels(60, 20, 60), omitIend: true });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'no_iend' });
  });

  // Valid magic, valid IHDR, valid IEND — and structurally undecodable. This is
  // the shape that passed an earlier structural-only design and then made
  // pdf-lib throw "Invalid typed array length: 0".
  it('a PNG with valid IHDR and IEND but no IDAT', async () => {
    const png = buildPng({ width: 60, height: 20, omitIdat: true });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'no_idat' });
  });

  // An APNG satisfies every structural check — legal IHDR, real base-frame
  // IDAT, visible alpha, trailing IEND — and pdf-lib still refuses it.
  it('an APNG (acTL chunk present)', async () => {
    const actl = new Uint8Array([...u32(2), ...u32(0)]); // 2 frames, infinite loop
    const png = buildPng({
      width: 60,
      height: 20,
      pixels: signaturePixels(60, 20, 60),
      extraChunks: [{ type: 'acTL', data: actl }],
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'animated' });
  });

  it('an interlaced (Adam7) PNG', async () => {
    const png = buildPng({ width: 60, height: 20, pixels: signaturePixels(60, 20, 60), interlace: 1 });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'interlaced' });
  });

  it.each([
    ['16-bit', { bitDepth: 16 }],
    ['palette (colour type 3)', { colorType: 3 }],
    ['greyscale+alpha (colour type 4)', { colorType: 4 }],
    // RGB is refused even though it decodes fine: see the tRNS case below.
    ['RGB (colour type 2)', { colorType: 2 }],
  ])('an unsupported format: %s', async (_label, extra) => {
    const png = buildPng({ width: 60, height: 20, pixels: signaturePixels(60, 20, 60), ...extra });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('zero dimensions', async () => {
    const png = buildPng({ width: 0, height: 0, rawIdat: new Uint8Array(deflateSync(Buffer.alloc(0))) });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'dimensions' });
  });

  it('an over-wide image', async () => {
    const png = buildPng({
      width: MAX_SIGNATURE_IMAGE_WIDTH + 1,
      height: 4,
      rawIdat: new Uint8Array(deflateSync(Buffer.alloc(16))),
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'dimensions' });
  });

  it('an over-tall image', async () => {
    const png = buildPng({
      width: 4,
      height: MAX_SIGNATURE_IMAGE_HEIGHT + 1,
      rawIdat: new Uint8Array(deflateSync(Buffer.alloc(16))),
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'dimensions' });
  });

  it('too many pixels, from the header, before inflating anything', async () => {
    // Within both per-axis caps, over the total. The point is that this is
    // refused from 13 bytes of IHDR — no allocation, no inflate.
    const width = MAX_SIGNATURE_IMAGE_WIDTH;
    const height = Math.ceil(MAX_SIGNATURE_IMAGE_PIXELS / width) + 1;
    expect(height).toBeLessThanOrEqual(MAX_SIGNATURE_IMAGE_HEIGHT);
    const png = buildPng({ width, height, rawIdat: new Uint8Array(deflateSync(Buffer.alloc(16))) });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'too_many_pixels' });
  });

  // The decompression bomb: a tiny request body that inflates enormously. The
  // IHDR pixel cap is the first net; this proves the inflate cap is the second,
  // for a header that lies about how much data its IDAT holds.
  //
  // The reason must be 'too_much_data', NOT 'corrupt': both guards reject this
  // input, so asserting the generic reason let either one be deleted with the
  // test still green. Mutation-checked.
  it('a small payload that inflates far past what its header implies', async () => {
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(8_000_000)));
    expect(bomb.length).toBeLessThan(50_000); // genuinely small on the wire
    const png = buildPng({ width: 10, height: 10, rawIdat: bomb });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'too_much_data' });
  });

  it('IDAT that inflates to fewer bytes than the header requires', async () => {
    // The other side of the size check: short, not long.
    const short = new Uint8Array(deflateSync(Buffer.alloc(10)));
    const png = buildPng({ width: 10, height: 10, rawIdat: short });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('IDAT that is not a valid zlib stream', async () => {
    const png = buildPng({ width: 10, height: 10, rawIdat: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('IDAT holding an unknown filter type', async () => {
    const stride = 10 * 4;
    const raw = new Uint8Array(10 * (stride + 1));
    for (let y = 0; y < 10; y += 1) raw[y * (stride + 1)] = 9; // no such filter
    const png = buildPng({ width: 10, height: 10, rawIdat: new Uint8Array(deflateSync(Buffer.from(raw))) });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'corrupt' });
  });

  // The nastiest blank: every pixel is solid black, and a tRNS chunk declares
  // black to be fully transparent. It scans as 100% ink against the pixel data,
  // embeds cleanly in pdf-lib, and renders as NOTHING — a legally signed
  // document with no visible signature and a burned token. Verified against the
  // real validator before the guard existed: {ok:true, inkPixels:40}.
  it('an RGB image whose tRNS chunk makes every "ink" pixel transparent', async () => {
    const width = 10;
    const height = 10;
    const png = buildPng({
      width,
      height,
      colorType: 2,
      pixels: new Uint8Array(width * height * 3), // all black
      extraChunks: [{ type: 'tRNS', data: new Uint8Array([0, 0, 0, 0, 0, 0]) }], // black = transparent
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('a tRNS chunk on an otherwise valid RGBA signature', async () => {
    const png = buildPng({
      width: 60,
      height: 20,
      pixels: signaturePixels(60, 20, 60),
      extraChunks: [{ type: 'tRNS', data: new Uint8Array([0, 0, 0, 0, 0, 0]) }],
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('a fully transparent image', async () => {
    const png = buildPng({ width: 60, height: 20 }); // all zero bytes = alpha 0
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'blank' });
  });

  // Fully OPAQUE white: a complete alpha channel, embeds perfectly, and renders
  // as nothing on a white page. An alpha-only ink check accepts this.
  it('an all-opaque-white image', async () => {
    const px = new Uint8Array(60 * 20 * 4).fill(0xff);
    const png = buildPng({ width: 60, height: 20, pixels: px });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'blank' });
  });

  it('a stray tap below the ink threshold', async () => {
    const png = buildPng({
      width: 60,
      height: 20,
      pixels: signaturePixels(60, 20, MIN_SIGNATURE_INK_PIXELS - 1),
    });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'blank' });
  });

  it('dark pixels that are almost entirely transparent', async () => {
    // Colour says ink, alpha says nothing is there. Darkness alone is as wrong
    // a test as alpha alone.
    const px = new Uint8Array(60 * 20 * 4);
    for (let i = 0; i < 200; i += 1) {
      px[i * 4] = 0x00;
      px[i * 4 + 1] = 0x00;
      px[i * 4 + 2] = 0x00;
      px[i * 4 + 3] = 0x04;
    }
    const png = buildPng({ width: 60, height: 20, pixels: px });
    expect(await validateSignatureImageBase64(b64(png))).toEqual({ ok: false, reason: 'blank' });
  });
});

// ── Helpers, tested directly ───────────────────────────────────────────────
//
// Both of these were added because the mutation check proved the public entry
// point could not distinguish their failures: with either guard removed the
// input was still rejected, by the other one.

describe('inflateCapped', () => {
  it('returns the inflated bytes when under the cap', async () => {
    const payload = Buffer.from('a signature is not compressible prose'.repeat(10));
    const out = await inflateCapped(new Uint8Array(deflateSync(payload)), 10_000);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out as Uint8Array)).toEqual(payload);
  });

  it('abandons the stream at the cap instead of buffering it all', async () => {
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(8_000_000)));
    expect(await inflateCapped(bomb, 1_000)).toBe(OVER_CAP);
  });

  it('returns null on a stream that is not zlib at all', async () => {
    expect(await inflateCapped(new Uint8Array([9, 9, 9, 9]), 10_000)).toBeNull();
  });
});

describe('unfilterScanlines', () => {
  // A gradient in BOTH axes, so left/above/upper-left are all different at every
  // pixel. On a uniform image a swapped Paeth reconstructs correctly by
  // coincidence — which is exactly what the mutation check caught.
  function gradient(width: number, height: number, bpp: number): Uint8Array {
    const px = new Uint8Array(width * height * bpp);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * bpp;
        for (let c = 0; c < bpp; c += 1) {
          px[at + c] = (x * 7 + y * 29 + c * 53) & 0xff;
        }
      }
    }
    return px;
  }

  it.each([0, 1, 2, 3, 4])('reverses filter type %i byte-for-byte', (filter) => {
    const width = 17;
    const height = 11;
    const bpp = 4;
    const original = gradient(width, height, bpp);
    const filtered = filterScanlines(original, width, height, bpp, filter);
    const out = unfilterScanlines(filtered, width, height, bpp);
    expect(out).not.toBeNull();
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(original));
  });

  it('rejects a buffer that is not exactly height x (stride + 1)', () => {
    const width = 8;
    const height = 4;
    const bpp = 4;
    const correct = height * (width * bpp + 1);
    expect(unfilterScanlines(new Uint8Array(correct - 1), width, height, bpp)).toBeNull();
    expect(unfilterScanlines(new Uint8Array(correct + 1), width, height, bpp)).toBeNull();
    expect(unfilterScanlines(new Uint8Array(correct), width, height, bpp)).not.toBeNull();
  });

  it('rejects an unknown filter type', () => {
    const width = 8;
    const height = 4;
    const bpp = 4;
    const raw = new Uint8Array(height * (width * bpp + 1));
    raw[0] = 5;
    expect(unfilterScanlines(raw, width, height, bpp)).toBeNull();
  });
});

// ── esign-signer-sign ──────────────────────────────────────────────────────

let w: World;
let finalized: string[] = [];

function deps(over: Partial<SignerSignDeps> = {}): SignerSignDeps {
  return {
    allowedOrigins: ORIGINS,
    db: w.db,
    pdf: pdfTools(),
    finalize: async (id) => {
      finalized.push(id);
      return true;
    },
    rateLimit: async () => 'allowed',
    logSink: w.logSink,
    ...over,
  };
}

const TYPED = { consent: true, consent_version: 'v1.0', kind: 'typed', signature_text: 'Ada Lovelace', font_key: 'great_vibes', timezone: 'America/New_York' };

const sign = (body: Record<string, unknown>, d = deps(), headers: Record<string, string> = { 'cf-connecting-ip': SIGNER_IP, 'User-Agent': 'Test agent' }) =>
  createSignerSignHandler(d)(edgeRequest({ headers, body }));

beforeAll(async () => {
  w = await createWorld();
}, 60_000);

describe('esign-signer-sign', () => {
  describeEdgeContract({
    name: 'esign-signer-sign',
    get handler() {
      return createSignerSignHandler(deps());
    },
    get failingHandler() {
      return createSignerSignHandler(deps({ db: { from: () => { throw new Error('contract-internal-detail-0451'); }, rpc: throwInternal } as never }));
    },
    limitedHandler: (req) => createSignerSignHandler(deps({ rateLimit: async () => 'limited' }))(req),
    credentials: null,
    body: { kind: 'json', valid: { ...TYPED, token: 'tok0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, maxBytes: 400_000 },
  });

  it('signs typed: the claim, the task, the activity row, partial status, and no finalize yet', async () => {
    const contactId = await seedContact(w, { email: 'ada@example.com' });
    const { envelopeId, signers } = await seedSentEnvelope(w, { title: 'Lease', signers: [{ email: 'ada@example.com', contactId }, { email: 'alan@example.com' }] });
    const [task] = await w.q<{ id: string }>(`INSERT INTO public.client_tasks (contact_id, title, type) VALUES ($1, 'Sign: Lease', 'esign') RETURNING id`, [contactId]);
    await w.q(`UPDATE public.esign_envelope_signers SET client_task_id = $2 WHERE id = $1`, [signers[0].id, task.id]);
    finalized = [];

    const res = await sign({ ...TYPED, signature_text: ' Ada Lovelace ', token: signers[0].token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, finalized: false });

    const [s] = await w.q<Record<string, unknown>>(
      `SELECT status, signed_signature_text, signed_font, signed_signature_kind, host(signed_ip) AS ip, signed_user_agent, signed_verification_method, signed_timezone,
              consent_disclosure_version, consented_at IS NOT NULL AS consented, token_expires_at <= now() AS link_spent
         FROM public.esign_envelope_signers WHERE id = $1`,
      [signers[0].id],
    );
    expect(s).toEqual({
      status: 'signed',
      signed_signature_text: 'Ada Lovelace',
      signed_font: 'great_vibes',
      signed_signature_kind: 'typed',
      ip: SIGNER_IP,
      signed_user_agent: 'Test agent',
      signed_verification_method: 'email',
      signed_timezone: 'America/New_York',
      consent_disclosure_version: 'v1.0',
      consented: true,
      link_spent: true,
    });
    const [t] = await w.q<{ status: string }>(`SELECT status FROM public.client_tasks WHERE id = $1`, [task.id]);
    expect(t.status).toBe('completed');
    const [act] = await w.q<{ action: string; details: Record<string, unknown> }>(`SELECT action, details FROM public.client_activity_log WHERE contact_id = $1`, [contactId]);
    expect(act).toEqual({ action: 'esign_signed', details: { envelope_id: envelopeId, envelope_title: 'Lease', signer_id: signers[0].id, verification_method: 'email' } });
    const [env] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelopes WHERE id = $1`, [envelopeId]);
    expect(env.status).toBe('partially_signed');
    expect(finalized).toEqual([]);
  });

  it('calls finalize when the last signer signs, and a repeat is harmless', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    finalized = [];
    expect(await (await sign({ ...TYPED, token: signers[0].token })).json()).toEqual({ ok: true, finalized: true });
    expect(finalized).toEqual([envelopeId]);
    expect(await (await sign({ ...TYPED, token: signers[0].token })).json()).toEqual({ ok: true, already_signed: true, finalized: false });
    expect(finalized).toEqual([envelopeId]);
  });

  it('signs drawn, storing the image, and refuses an image the PDF library cannot embed', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    const image = await drawnSignaturePng();
    const res = await sign({ consent: true, kind: 'drawn', signature_image: image, timezone: 'UTC', token: signers[0].token });
    expect(res.status).toBe(200);
    const [img] = await w.q<{ image_base64: string }>(`SELECT image_base64 FROM public.esign_signer_signature_images WHERE signer_id = $1`, [signers[0].id]);
    expect(img.image_base64).toBe(image);

    const refusing = deps({ pdf: { trialEmbedPng: async () => false } });
    const bad = await sign({ consent: true, kind: 'drawn', signature_image: image, timezone: 'UTC', token: signers[1].token }, refusing);
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_signature');
    const [s] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE id = $1`, [signers[1].id]);
    expect(s.status).toBe('invited');
  });

  it('refuses a blank drawing the PDF library would embed happily', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const blank = b64(buildPng({ width: 60, height: 20 }));
    expect(await pdfTools().trialEmbedPng(blank)).toBe(true);
    const res = await sign({ consent: true, kind: 'drawn', signature_image: blank, timezone: 'UTC', token: signers[0].token });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_signature');
  });

  it('refuses what finalize could not draw, before any write', async () => {
    const { signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const token = signers[0].token;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...TYPED, consent: undefined }, 'consent_required'],
      [{ ...TYPED, kind: 'stamp' }, 'invalid_signature'],
      [{ ...TYPED, signature_text: 'Ada 一' }, 'invalid_signature'],
      [{ ...TYPED, signature_text: 'x'.repeat(81) }, 'invalid_signature'],
      [{ ...TYPED, signature_text: '' }, 'invalid_signature'],
      [{ ...TYPED, signature_image: 'AAAA' }, 'invalid_signature'],
      [{ ...TYPED, font_key: 'comic_sans' }, 'invalid_font'],
      [{ ...TYPED, timezone: 'Europe/Paris; drop' }, 'invalid_timezone'],
      [{ ...TYPED, timezone: undefined }, 'invalid_timezone'],
      [{ consent: true, kind: 'drawn', signature_image: 'not base64', timezone: 'UTC' }, 'invalid_signature'],
      [{ consent: true, kind: 'drawn', signature_image: await drawnSignaturePng(), font_key: 'allison', timezone: 'UTC' }, 'invalid_signature'],
    ];
    for (const [body, code] of cases) {
      const res = await sign({ ...body, token });
      expect([code, res.status]).toEqual([code, 400]);
      expect((await res.json()).code).toBe(code);
    }
    const [s] = await w.q<{ status: string }>(`SELECT status FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.status).toBe('invited');
  });

  it('keeps consent recorded earlier, and an unrecognised version is recorded as none', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET consented_at = '2030-01-01T00:00:00Z', consent_disclosure_version = 'v0.9' WHERE id = $1`, [signers[0].id]);
    await sign({ ...TYPED, token: signers[0].token });
    await sign({ ...TYPED, consent_version: 'v1 <b>', token: signers[1].token });
    const rows = await w.q<{ v: string | null; at: string }>(
      `SELECT consent_disclosure_version AS v, (consented_at AT TIME ZONE 'UTC')::date::text AS at FROM public.esign_envelope_signers WHERE envelope_id = $1 ORDER BY "order"`,
      [envelopeId],
    );
    expect(rows[0]).toEqual({ v: 'v0.9', at: '2030-01-01' });
    expect(rows[1].v).toBeNull();
  });

  it("requires the SMS session on a 'high' envelope, from the address that opened it", async () => {
    const { signers } = await seedSentEnvelope(w, { level: 'high', signers: [{ email: 'ada@example.com', phone: '+15555550123' }] });
    const session = await openSession(w, signers[0].id);
    const none = await sign({ ...TYPED, token: signers[0].token });
    expect(none.status).toBe(401);
    expect((await none.json()).code).toBe('session_required');
    const elsewhere = await sign({ ...TYPED, token: signers[0].token, session_token: session }, deps(), { 'cf-connecting-ip': '198.51.100.7' });
    expect(elsewhere.status).toBe(401);
    expect((await sign({ ...TYPED, token: signers[0].token, session_token: session })).status).toBe(200);
    const [s] = await w.q<{ m: string }>(`SELECT signed_verification_method AS m FROM public.esign_envelope_signers WHERE id = $1`, [signers[0].id]);
    expect(s.m).toBe('email+sms');
  });

  it('answers one 404 for a link that cannot sign', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }, { email: 'alan@example.com' }] });
    await w.q(`UPDATE public.esign_envelope_signers SET token_expires_at = now() - interval '1 second' WHERE id = $1`, [signers[0].id]);
    expect((await sign({ ...TYPED, token: signers[0].token })).status).toBe(404);
    await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
    expect((await sign({ ...TYPED, token: signers[1].token })).status).toBe(404);
    expect((await sign({ ...TYPED, token: 'unknown-token-0123456789abcdef' })).status).toBe(404);
  });

  it('loses to a void that lands during the signing', async () => {
    const { envelopeId, signers } = await seedSentEnvelope(w, { signers: [{ email: 'ada@example.com' }] });
    const racing = {
      from: (t: string) => w.db.from(t),
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'esign_claim_signer_signature') await w.q(`UPDATE public.esign_envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [envelopeId]);
        return w.db.rpc(fn, args);
      },
    };
    const res = await sign({ ...TYPED, token: signers[0].token }, deps({ db: racing }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_signable');
  });
});
