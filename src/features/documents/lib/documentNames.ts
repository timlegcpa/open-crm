import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES, verifyMagicBytes } from '../../../../supabase/functions/_shared/magic-bytes';

/** `max` is 255 for a file; a folder passes 100, the folder-name CHECK's bound. */
export function validateName(name: string, max = 255): string | null {
  if (!name) return 'Name cannot be empty.';
  if (name.length > max) return `Name must be ${max} characters or fewer.`;
  if (/[/\\]/.test(name)) return 'Name cannot contain / or \\ characters.';
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Name cannot contain control characters.';
  if (FORMAT_CHAR.test(name)) return 'Name cannot contain invisible formatting characters.';
  if (name === '.' || name === '..') return 'Invalid name.';
  return null;
}

/**
 * Unicode format characters (category Cf): invisible, and a right-to-left override
 * (U+202E) makes "invoice<RLO>fdp.exe" display as "invoiceexe.pdf". The database CHECKs
 * on file and folder names refuse the same class.
 */
const FORMAT_CHAR = /\p{Cf}/u;
const FORMAT_CHARS = /\p{Cf}/gu;

/** The extension a saved file gets for each stored type; the first is the one appended. */
const EXTENSIONS: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/msword': ['doc'],
  'application/vnd.ms-excel': ['xls'],
  'text/csv': ['csv'],
  'text/plain': ['txt'],
};

/**
 * The name a document is SAVED under: the person's name for it, with the extension of
 * its STORED type, never the uploader's. The bytes were checked against the stored type,
 * not against the name, so "notes.hta" holding plain text saves as "notes.txt", and a
 * macro workbook uploaded as "book.xlsm" (stored as xlsx) saves as "book.xlsx", which
 * Office refuses to run macros from. An unknown type saves as ".bin".
 */
export function savedFileName(name: string, mimeType: string): string {
  const allowed = EXTENSIONS[mimeType] ?? ['bin'];
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  let stem = name.replace(FORMAT_CHARS, '').replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim();
  const dot = stem.lastIndexOf('.');
  if (dot >= 0 && /^[a-zA-Z0-9]{1,8}$/.test(stem.slice(dot + 1))) {
    if (dot > 0 && allowed.includes(stem.slice(dot + 1).toLowerCase())) return stem;
    stem = stem.slice(0, dot);
  }
  // A name like ".hta" leaves no stem.
  stem = stem.replace(/\.+$/, '').trim() || 'document';
  return `${stem.slice(0, 240)}.${allowed[0]}`;
}

export const ALLOWED_TYPES = ALLOWED_UPLOAD_MIME_TYPES as readonly string[];
export const MAX_FILE_SIZE = MAX_UPLOAD_BYTES;

/** Text has no signature, so its check reads the whole file; every other type, its first bytes. */
const SIGNATURE_BYTES = 16;
const TEXT_TYPES = new Set(['text/csv', 'text/plain']);

async function bytesMatchType(f: File): Promise<boolean> {
  const slice = TEXT_TYPES.has(f.type) ? f : f.slice(0, SIGNATURE_BYTES);
  return verifyMagicBytes(f.type, new Uint8Array(await slice.arrayBuffer()));
}

/**
 * The browser's upload gauntlet (type allowlist, size cap, bytes match the type), shared
 * by every upload surface. The server runs the same checks again: this one only spares
 * the user a refused upload. `reason` is the "Skipped" toast copy.
 */
export async function validateUploadFiles(
  files: File[],
): Promise<{ accepted: File[]; rejected: { file: File; reason: string }[] }> {
  const accepted: File[] = [];
  const rejected: { file: File; reason: string }[] = [];
  for (const f of files) {
    if (!ALLOWED_TYPES.includes(f.type)) {
      rejected.push({ file: f, reason: 'unsupported file type' });
      continue;
    }
    if (f.size > MAX_FILE_SIZE) {
      rejected.push({ file: f, reason: `over the ${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB limit` });
      continue;
    }
    if (f.size === 0) {
      rejected.push({ file: f, reason: 'the file is empty' });
      continue;
    }
    if (!(await bytesMatchType(f))) {
      rejected.push({ file: f, reason: 'the content does not match its type' });
      continue;
    }
    accepted.push(f);
  }
  return { accepted, rejected };
}

export function renderContains(cc: { folders: number; files: number } | undefined): string {
  if (!cc) return '\u2013';
  if (cc.folders === 0 && cc.files === 0) return 'Empty';
  return [
    cc.folders > 0 ? `${cc.folders} folder${cc.folders !== 1 ? 's' : ''}` : null,
    cc.files > 0 ? `${cc.files} file${cc.files !== 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(', ');
}

export function buildFolderPaths(
  allFolders: Record<string, unknown>[],
): { label: string; path: string }[] {
  const paths: { label: string; path: string }[] = [{ label: 'Top level', path: '/' }];
  for (const f of allFolders) {
    const fullPath = (f.parent_path as string) + (f.name as string) + '/';
    const depth = fullPath.split('/').filter(Boolean).length;
    const indent = '\u00A0\u00A0'.repeat(depth);
    paths.push({ label: `${indent}${f.name as string}`, path: fullPath });
  }
  return paths;
}
