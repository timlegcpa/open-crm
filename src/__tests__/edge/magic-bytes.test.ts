// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  isAllowedUploadMime,
  MAGIC_BYTES,
  MAX_UPLOAD_BYTES,
  verifyMagicBytes,
} from '../../../supabase/functions/_shared/magic-bytes';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (s: string) => new TextEncoder().encode(s);
const withTail = (head: Uint8Array) => {
  const out = new Uint8Array(head.length + 32);
  out.set(head);
  return out;
};

const PDF = ascii('%PDF-1.7');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF = ascii('GIF89a');
const WEBP = Uint8Array.from([...ascii('RIFF'), 0x24, 0x10, 0x00, 0x00, ...ascii('WEBPVP8 ')]);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const OLE2 = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const GENUINE: Array<[string, Uint8Array]> = [
  ['application/pdf', PDF],
  ['image/jpeg', JPEG],
  ['image/png', PNG],
  ['image/gif', GIF],
  ['image/webp', WEBP],
  [XLSX, ZIP],
  [DOCX, ZIP],
  ['application/msword', OLE2],
  ['application/vnd.ms-excel', OLE2],
];

describe('verifyMagicBytes', () => {
  it.each(GENUINE)('accepts a genuine %s', (mime, head) => {
    expect(verifyMagicBytes(mime, withTail(head))).toBe(true);
  });

  it.each(GENUINE)('refuses %s whose bytes are something else', (mime) => {
    expect(verifyMagicBytes(mime, withTail(ascii('<html><script>')))).toBe(false);
  });

  it.each(GENUINE)('refuses %s cut shorter than its signature', (mime, head) => {
    const sig = MAGIC_BYTES[mime][0];
    expect(verifyMagicBytes(mime, head.subarray(0, sig.length - 1))).toBe(false);
    expect(verifyMagicBytes(mime, new Uint8Array(0))).toBe(false);
  });

  it('refuses a declared type that the bytes contradict', () => {
    expect(verifyMagicBytes('application/pdf', withTail(PNG))).toBe(false);
    expect(verifyMagicBytes('image/png', withTail(JPEG))).toBe(false);
    expect(verifyMagicBytes(DOCX, withTail(OLE2))).toBe(false);
  });

  it('treats the WebP size bytes as wildcards but still checks the WEBP marker', () => {
    expect(verifyMagicBytes('image/webp', Uint8Array.from([...ascii('RIFF'), 0xff, 0xff, 0xff, 0xff, ...ascii('WEBP')]))).toBe(true);
    expect(verifyMagicBytes('image/webp', Uint8Array.from([...ascii('RIFF'), 0x24, 0x10, 0x00, 0x00, ...ascii('WAVE')]))).toBe(false);
  });

  it('accepts CSV and plain text on the allowlist alone, since they have no signature', () => {
    expect(verifyMagicBytes('text/csv', ascii('name,amount\n'))).toBe(true);
    expect(verifyMagicBytes('text/plain', new Uint8Array(0))).toBe(true);
  });

  it('refuses every type that is not on the allowlist, even when the bytes match a listed one', () => {
    for (const [mime, head] of [
      ['application/vnd.ms-word.document.macroEnabled.12', ZIP], // .docm
      ['application/vnd.ms-excel.sheet.macroEnabled.12', ZIP], // .xlsm
      ['application/zip', ZIP],
      ['text/html', ascii('<html>')],
      ['image/svg+xml', ascii('<svg ')],
      ['application/octet-stream', PDF],
      ['', PDF],
      ['APPLICATION/PDF', PDF],
    ] as const) {
      expect([mime, verifyMagicBytes(mime, withTail(head))]).toEqual([mime, false]);
    }
  });

  it('reads an ArrayBuffer as well as a Uint8Array', () => {
    expect(verifyMagicBytes('application/pdf', withTail(PDF).buffer)).toBe(true);
    expect(verifyMagicBytes('application/pdf', withTail(PNG).buffer)).toBe(false);
  });
});

describe('the upload allowlist', () => {
  it('is the expected eleven types, with a 25 MB cap', () => {
    expect(ALLOWED_UPLOAD_MIME_TYPES).toHaveLength(11);
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(ALLOWED_UPLOAD_MIME_TYPES.every(isAllowedUploadMime)).toBe(true);
    expect(isAllowedUploadMime('text/html')).toBe(false);
  });

  it('has a signature for every type except the two text types, and no signature for an unlisted type', () => {
    const signed = Object.keys(MAGIC_BYTES).sort();
    const unsigned = ALLOWED_UPLOAD_MIME_TYPES.filter((m) => !signed.includes(m));
    expect(unsigned).toEqual(['text/csv', 'text/plain']);
    expect(signed.every(isAllowedUploadMime)).toBe(true);
  });
});
