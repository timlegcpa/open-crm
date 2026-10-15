// esign-upload-document: a source PDF into a draft envelope. Owner only.
//
// Multipart (fields `file`, `envelope_id`, `file_name`), never base64 in JSON: base64
// held four copies of a large file in memory before anything checked it. The bytes must
// start %PDF (verifyMagicBytes), load in pdf-lib (an encrypted PDF is refused) and hold
// 1 to 200 pages, and the envelope may hold at most 200 live pages in all, because a
// field's page_index is 0..199.
//
// The object is stored at {envelope}/sources/{document}.pdf with no upsert, then
// esign_insert_document_with_pages writes the document and its page rows in one
// transaction under the envelope's row lock. Storage is not in that transaction, so when
// the RPC fails the object is removed again: esign-working holds plaintext and an
// object with no row is one nothing would ever find.

import type { AuthOutcome, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import { MAX_UPLOAD_BYTES, verifyMagicBytes } from '../_shared/magic-bytes.ts';
import { call, countOf, maybeOne, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, envelopeNotFound, notDraft, rpcRefusal } from '../esign-finalize-envelope/lib/errors.ts';
import type { PdfTools } from '../esign-finalize-envelope/lib/pdf.ts';
import type { EsignStorage } from '../esign-finalize-envelope/lib/storage.ts';
import { stripControl } from '../esign-finalize-envelope/lib/text.ts';

/** multipart/form-data: file (application/pdf), envelope_id, file_name. */
export interface UploadDocumentRequest {
  file: File;
  envelope_id: string;
  file_name: string;
}

export interface UploadDocumentResponse {
  document: { id: string; file_name: string; page_count: number; order: number };
  pages: Array<{ id: string; order: number; source_page_index: number }>;
}

export const UPLOAD_DOCUMENT_ERRORS = [
  'bad_request',
  'not_pdf',
  'file_too_large',
  'unreadable_pdf',
  'too_many_pages',
  'not_found',
  'not_draft',
] as const;

/** The multipart body: the largest upload plus room for the boundary and the two text fields. */
export const UPLOAD_BODY_BYTES = 27_262_976;
export const MAX_PAGES = 200;
const MAX_FILE_NAME = 200;

export interface UploadDocumentDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  db: EsignDb;
  storage: EsignStorage;
  pdf: Pick<PdfTools, 'pageCount'>;
  newId?: () => string;
  logSink?: LogSink;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : null;
};

export function createUploadDocumentHandler(deps: UploadDocumentDeps): (req: Request) => Promise<Response> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  return createHandler({
    name: 'esign-upload-document',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner },
    body: 'form',
    maxBodyBytes: UPLOAD_BODY_BYTES,
    logSink: deps.logSink,
    async handle({ body, json, log }) {
      const file = body.get('file');
      const envelopeId = field(body, 'envelope_id');
      const fileName = stripControl(field(body, 'file_name') ?? '');
      if (!(file instanceof Blob) || !isUuid(envelopeId) || fileName.length < 1 || fileName.length > MAX_FILE_NAME) {
        throw badRequest();
      }
      if (file.type !== 'application/pdf') throw badRequest('Only PDF files can be signed.', 'not_pdf');
      if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) throw badRequest('The PDF must be under 25 MB.', 'file_too_large');

      const envelope = await maybeOne<{ status: string }>(
        'envelope read',
        deps.db.from('esign_envelopes').select('id, status').eq('id', envelopeId).maybeSingle(),
      );
      if (!envelope) throw envelopeNotFound();
      if (envelope.status !== 'draft') throw notDraft();

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!verifyMagicBytes('application/pdf', bytes)) throw badRequest('That file is not a PDF.', 'not_pdf');
      let pageCount: number;
      try {
        pageCount = await deps.pdf.pageCount(bytes);
      } catch {
        throw badRequest('That PDF could not be read. It may be damaged or password-protected.', 'unreadable_pdf');
      }
      if (pageCount < 1 || pageCount > MAX_PAGES) throw badRequest('A PDF must have 1 to 200 pages.', 'too_many_pages');
      const live = await countOf(
        'page count',
        deps.db.from('esign_envelope_pages').select('id', { count: 'exact', head: true }).eq('envelope_id', envelopeId).eq('deleted', false),
      );
      if (live + pageCount > MAX_PAGES) {
        throw new HttpError(409, 'An envelope can hold at most 200 pages.', 'too_many_pages');
      }

      const documentId = newId();
      const path = `${envelopeId}/sources/${documentId}.pdf`;
      await deps.storage.putWorking(path, bytes, { upsert: false });

      let inserted: { document_order: number; pages: UploadDocumentResponse['pages'] };
      try {
        inserted = await call(deps.db, 'esign_insert_document_with_pages', {
          p_envelope_id: envelopeId,
          p_document_id: documentId,
          p_file_name: fileName,
          p_storage_path: path,
          p_byte_size: bytes.byteLength,
          p_page_count: pageCount,
        });
      } catch (err) {
        try {
          await deps.storage.removeWorking([path]);
        } catch (cleanupErr) {
          // The object has no row; this line is its only record.
          log.error('compensation failed; a working object is stranded', cleanupErr, { envelope_id: envelopeId, document_id: documentId });
        }
        throw rpcRefusal(err) ?? err;
      }

      const response: UploadDocumentResponse = {
        document: { id: documentId, file_name: fileName, page_count: pageCount, order: inserted.document_order },
        pages: inserted.pages,
      };
      return json(200, response);
    },
  });
}
