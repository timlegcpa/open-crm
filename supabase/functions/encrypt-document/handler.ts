// encrypt-document: the one way a file enters the documents store. The owner uploads into
// either section of any contact; a client only into its own uploads ('client').
//
// The door (origin, method, owner or client, View as client refused, the client's rate
// limit before the body, the capped multipart read, headers, generic errors) is
// createHandler's. Then, in order: the fields, the destination (the contact and folder
// exist), the size, the bytes against the declared type (magic-bytes.ts, which also holds
// the type allowlist), AES-GCM with a fresh IV, the object (never overwriting), the row,
// and the client's activity row.
//
// View as client must be refused HERE, not only by the database: this function writes
// as the server, which the database's read-only trigger lets through, so an upload made
// while the owner views as the client would be filed as the client's own.
//
// Everything outside this file is injected, so the tests run this exact code with the
// database steps against the real migrations.

import type { AuthOutcome, ClientPrincipal, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { MAX_UPLOAD_BYTES, verifyMagicBytes } from '../_shared/magic-bytes.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';

/** The file plus multipart framing and the small fields; the default body cap would refuse every upload. */
export const MAX_FORM_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

export type HeldBy = 'owner' | 'client';

export interface NewDocumentRow {
  contact_id: string;
  uploaded_by: string;
  filename: string;
  original_filename: string;
  storage_path: string;
  file_size: number;
  mime_type: string;
  category: string;
  description: string | null;
  folder_path: string;
  held_by: HeldBy;
  encryption_iv: string;
  encryption_status: 'encrypted';
}

export interface UploadActivity {
  contact_id: string;
  user_id: string;
  details: { document_id: string; filename: string; held_by: HeldBy; actor_role: 'owner' | 'client' };
  ip_address: string | null;
  user_agent: string | null;
}

export interface EncryptDocumentDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  /** The client's bucket: 60 uploads an hour. The owner is uncapped (bulk intake). */
  limitClient(userId: string): Promise<RateLimitOutcome>;
  /** The contact exists and the path is '/' or one of its folders in that section. */
  destinationExists(contactId: string, heldBy: HeldBy, folderPath: string): Promise<boolean>;
  /** AES-GCM under DOCUMENT_ENCRYPTION_KEY with a fresh IV (base64 in the result). */
  encrypt(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: string }>;
  /** Store the object, never overwriting one. Throws on any failure. */
  putObject(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * The id of the row filed over this object, or null when there is none. Asked only
   * after an insert failed, because a failure can be a lost acknowledgement of an insert
   * that committed. Throws on any failure.
   */
  findRowByStoragePath(path: string): Promise<string | null>;
  /** Insert the row; resolves to its id. Throws on any failure. */
  insertRow(row: NewDocumentRow): Promise<string>;
  recordActivity(activity: UploadActivity): Promise<void>;
  newId(): string;
  now(): Date;
  logSink?: LogSink;
}

const bad = (message: string): HttpError => new HttpError(400, message, REFUSALS.badRequest.code);

/** A folder path as the database stores it: '/' or '/a/b/', each segment clean, at most 200 characters. */
// deno-lint-ignore no-control-regex -- refusing control characters is the point
const FOLDER_PATH = /^\/([^/\\\u0000-\u001f\u007f]+\/)*$/;
export function isFolderPath(value: string): boolean {
  return value.length <= 200 && FOLDER_PATH.test(value) && !/\/\.{1,2}\//.test(value);
}

/**
 * The name people see: one path segment, at most 255 characters, never empty. Unicode
 * format characters (category Cf) are dropped: a right-to-left override (U+202E) makes
 * "invoice<RLO>fdp.exe" display as "invoiceexe.pdf", and the original_filename CHECK
 * refuses the same class.
 */
export function displayName(name: string): string {
  const clean = name
    .replace(/\p{Cf}/gu, '')
    // deno-lint-ignore no-control-regex -- refusing control characters is the point
    .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
    .trim();
  if (!clean) return 'document';
  if (clean.length <= 255) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 9 ? clean.slice(dot) : '';
  return clean.slice(0, 255 - ext.length) + ext;
}

/** The object's extension: the file's own when it is short and plain, else 'bin'. */
export function objectExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  return /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : 'bin';
}

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' ? value : null;
}

export function createEncryptDocumentHandler(deps: EncryptDocumentDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'encrypt-document',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner, client: deps.authorizeClient },
    clientWrites: true,
    rateLimit: ({ principal }) => (principal.kind === 'owner' ? Promise.resolve('allowed') : deps.limitClient(principal.userId)),
    body: 'form',
    maxBodyBytes: MAX_FORM_BYTES,
    logSink: deps.logSink,
    async handle({ principal, body: form, json, ip, userAgent, log }) {
      const file = form.get('file');
      if (!(file instanceof Blob)) throw bad('Choose a file to upload.');
      const contactId = field(form, 'contact_id');
      if (!isUuid(contactId)) throw bad('The contact is missing.');
      const heldBy = field(form, 'held_by') ?? 'client';
      if (heldBy !== 'owner' && heldBy !== 'client') throw bad('The section is not valid.');

      // A client uploads only into its own uploads.
      if (principal.kind === 'client' && (contactId !== principal.contactId || heldBy !== 'client')) {
        throw new HttpError(REFUSALS.forbidden.status, REFUSALS.forbidden.error, REFUSALS.forbidden.code);
      }

      const folderPath = field(form, 'folder_path') ?? '/';
      if (!isFolderPath(folderPath)) throw bad('The folder is not valid.');
      const category = (field(form, 'category') ?? 'general').trim() || 'general';
      if (category.length > 100) throw bad('The category is too long.');
      const description = field(form, 'description')?.trim() || null;
      if (description !== null && description.length > 500) throw bad('The description is too long.');

      // A row filed under a path with no folder could never be reached from a folder view.
      if (!(await deps.destinationExists(contactId, heldBy, folderPath))) {
        throw new HttpError(404, 'That folder does not exist.', 'folder_not_found');
      }

      if (file.size === 0) throw bad('The file is empty.');
      if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'The file is larger than 25 MB.', REFUSALS.tooLarge.code);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mimeType = file.type;
      if (!verifyMagicBytes(mimeType, bytes)) {
        throw new HttpError(415, 'This type of file cannot be uploaded, or it does not match its type.', 'unsupported_file');
      }

      const name = file instanceof File ? file.name : '';
      const originalFilename = displayName(name);
      const objectName = `${deps.newId()}.${objectExtension(name)}.enc`;
      const storagePath = `${contactId}/${deps.now().getUTCFullYear()}/${objectName}`;

      const { ciphertext, iv } = await deps.encrypt(bytes);
      await deps.putObject(storagePath, ciphertext);

      let documentId: string;
      try {
        documentId = await deps.insertRow({
          contact_id: contactId,
          uploaded_by: principal.userId,
          filename: objectName,
          original_filename: originalFilename,
          storage_path: storagePath,
          file_size: bytes.byteLength,
          mime_type: mimeType,
          category,
          description,
          folder_path: folderPath,
          held_by: heldBy,
          encryption_iv: iv,
          encryption_status: 'encrypted',
        });
      } catch (err) {
        // NEVER delete the object here. An insert can fail after it committed (the answer
        // was lost on the way back), and removing the object then would leave a live row
        // over deleted content. Nothing in this function deletes a stored document: ask
        // whether the row exists; if it does, the upload succeeded; if not, the object is
        // an orphan and stays for the orphan report.
        let existing: string | null = null;
        try {
          existing = await deps.findRowByStoragePath(storagePath);
        } catch (findErr) {
          log.error('row lookup after a failed insert failed; the object may be an orphan', findErr);
        }
        if (existing === null) {
          log.error('row insert failed; the object is an orphan, left for the orphan report', err);
          throw err;
        }
        log.warn('row insert reported a failure but the row exists; answering success');
        documentId = existing;
      }

      // Network details only for a client's own upload: the owner's address is not the
      // client's to read, and an owner upload lands on a row the client sees.
      const isClient = principal.kind === 'client';
      try {
        await deps.recordActivity({
          contact_id: contactId,
          user_id: principal.userId,
          details: { document_id: documentId, filename: originalFilename, held_by: heldBy, actor_role: isClient ? 'client' : 'owner' },
          ip_address: isClient ? ip : null,
          user_agent: isClient ? (userAgent?.slice(0, 512) ?? null) : null,
        });
      } catch (err) {
        log.error('activity row failed', err);
      }

      return json(200, { id: documentId, filename: originalFilename });
    },
  });
}
