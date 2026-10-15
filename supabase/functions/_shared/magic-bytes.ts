// What an upload may be, checked on the server against the bytes themselves. The
// browser checks too, but a direct call skips the browser, so every function that
// stores an uploaded file calls verifyMagicBytes before writing it.
//
// The allowlist is the source system's. Accepted risk, carried over: legacy Office
// files (.doc, .xls, OLE2) are allowed because real clients still send them, and OLE2
// can carry VBA macros; the mitigation is the reader's Office Protected View on
// download. Macro-enabled OOXML (.docm, .xlsm) has its own MIME types, which are not
// on the list, so a file declared as one is refused; the bytes alone cannot tell it from
// .docx or .xlsx (all are ZIP), so a download names the file by its stored MIME type,
// never by the uploader's file name. A Storage bucket that holds uploads lists the same
// MIME types in allowed_mime_types; change all three places together (this file, the
// browser's list, the bucket).
//
// Pure TypeScript, and the browser imports this file directly (documents' upload checks,
// documentNames.ts and the annotator's export), so the browser and the server read one list
// and one size cap. Keep it free of Deno globals and of anything a browser bundle cannot
// load.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'application/vnd.ms-excel', // xls
  'text/csv',
  'text/plain',
] as const;

export type UploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

// null is a wildcard byte (WebP: RIFF....WEBP, where bytes 4-7 are the chunk size).
export const MAGIC_BYTES: Readonly<Record<string, readonly (readonly (number | null)[])[]>> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]], // GIF8
  'image/webp': [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]], // RIFF....WEBP
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [[0x50, 0x4b, 0x03, 0x04]], // ZIP
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [[0x50, 0x4b, 0x03, 0x04]], // ZIP
  'application/msword': [[0xd0, 0xcf, 0x11, 0xe0]], // OLE2
  'application/vnd.ms-excel': [[0xd0, 0xcf, 0x11, 0xe0]], // OLE2
};

export function isAllowedUploadMime(mime: string): mime is UploadMimeType {
  return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime);
}

// Text has no signature, so its check is the content: valid UTF-8 with no control
// character other than tab, line feed, form feed and carriage return.
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set(['text/csv', 'text/plain']);
// deno-lint-ignore no-control-regex -- matching control characters is the point
const BINARY_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

function isPlainText(view: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    return false;
  }
  return !BINARY_CONTROL.test(text);
}

/**
 * True when `mime` is on the allowlist AND the bytes are what it claims: the type's
 * signature, or for CSV and plain text, text. A type that is not on the list never
 * passes, so a caller cannot forget the allowlist check.
 */
export function verifyMagicBytes(mime: string, bytes: Uint8Array | ArrayBuffer): boolean {
  if (!isAllowedUploadMime(mime)) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (TEXT_MIME_TYPES.has(mime)) return isPlainText(view);
  const signatures = MAGIC_BYTES[mime];
  if (!signatures) return false;
  return signatures.some((sig) => view.length >= sig.length && sig.every((byte, i) => byte === null || view[i] === byte));
}
