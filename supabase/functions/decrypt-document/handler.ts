// decrypt-document: the one way a document's bytes leave the store. The owner opens any
// document; a client opens its own (either section) and any single document shared with it.
// Reads are allowed in View as client, so this function declares clientWrites: false.
//
// Answers:
//   encrypted rows   the plaintext as application/octet-stream, ALWAYS, whatever the
//                    document's type: supabase-js hands only octet-stream and PDF bodies
//                    back as a Blob and reads every other type as text, which corrupts an
//                    image or a spreadsheet. The browser retypes the Blob from the row, and
//                    names a download from the row too (no response header reaches it).
//   plaintext rows   (an e-signed PDF) JSON { signed_url, filename, mime_type, mode:
//                    'redirect' } with a five-minute signed URL.
// Every response is no-store (createHandler's security headers).
//
// A missing document and someone else's document get the same 404, so an id never tells
// a caller that it exists. No storage-path check: an e-signed PDF filed to a co-signer
// points at an object under the first signer's path.
//
// A 'download' writes a document_download activity row; a 'preview' writes nothing. The
// caller's address and browser are recorded only when the caller is the document's own
// contact at its own keyboard: never the owner's, never a household recipient's, and
// never under View as client (that session is the owner's, so it is recorded as the owner).

import type { AuthOutcome, ClientPrincipal, OwnerPrincipal } from '../_shared/auth.ts';
import { createHandler, HttpError, REFUSALS } from '../_shared/handler.ts';
import { isUuid } from '../_shared/http.ts';
import type { LogSink } from '../_shared/log.ts';
import type { RateLimitOutcome } from '../_shared/rate-limit.ts';

export const SIGNED_URL_SECONDS = 300;

export interface StoredDocument {
  id: string;
  contact_id: string;
  shared_with_contact_id: string | null;
  original_filename: string;
  mime_type: string;
  storage_path: string;
  encryption_status: 'none' | 'encrypted';
  encryption_iv: string | null;
}

export interface DownloadActivity {
  contact_id: string;
  user_id: string;
  details: { document_id: string; filename: string; actor_role: 'owner' | 'client' };
  ip_address: string | null;
  user_agent: string | null;
}

export interface DecryptDocumentDeps {
  allowedOrigins: string[];
  authorizeOwner(token: string): Promise<AuthOutcome<OwnerPrincipal>>;
  authorizeClient(token: string): Promise<AuthOutcome<ClientPrincipal>>;
  /** The client's bucket: 200 an hour (a preview and a download are two). The owner is uncapped. */
  limitClient(userId: string): Promise<RateLimitOutcome>;
  /** Read as the server; null when there is no such row. */
  loadDocument(id: string): Promise<StoredDocument | null>;
  /** The object's bytes. Throws on any failure. */
  getObject(path: string): Promise<Uint8Array>;
  /** AES-GCM open under DOCUMENT_ENCRYPTION_KEY. Throws when the bytes or IV do not authenticate. */
  decrypt(ciphertext: Uint8Array, iv: string): Promise<Uint8Array>;
  signedUrl(path: string, seconds: number): Promise<string>;
  recordActivity(activity: DownloadActivity): Promise<void>;
  logSink?: LogSink;
}

const NOT_FOUND = () => new HttpError(404, 'Document not found.', 'not_found');

export function createDecryptDocumentHandler(deps: DecryptDocumentDeps): (req: Request) => Promise<Response> {
  return createHandler({
    name: 'decrypt-document',
    allowedOrigins: deps.allowedOrigins,
    auth: { owner: deps.authorizeOwner, client: deps.authorizeClient },
    clientWrites: false,
    rateLimit: ({ principal }) => (principal.kind === 'owner' ? Promise.resolve('allowed') : deps.limitClient(principal.userId)),
    body: 'json',
    maxBodyBytes: 1024,
    logSink: deps.logSink,
    async handle({ principal, body, json, ip, userAgent, log }) {
      const input = (body ?? {}) as { document_id?: unknown; purpose?: unknown };
      if (!isUuid(input.document_id)) throw new HttpError(400, 'The document is missing.', REFUSALS.badRequest.code);
      const purpose = input.purpose;
      if (purpose !== 'preview' && purpose !== 'download') {
        throw new HttpError(400, 'Say whether this is a preview or a download.', REFUSALS.badRequest.code);
      }

      const doc = await deps.loadDocument(input.document_id);
      if (!doc) throw NOT_FOUND();
      if (principal.kind === 'client') {
        // The same rule as the table's SELECT policy: own row, or shared with this contact.
        const allowed = doc.contact_id === principal.contactId || doc.shared_with_contact_id === principal.contactId;
        if (!allowed) throw NOT_FOUND();
      }

      if (purpose === 'download') {
        const self = principal.kind === 'client' && !principal.impersonating && principal.contactId === doc.contact_id;
        const actsAsClient = principal.kind === 'client' && !principal.impersonating;
        try {
          await deps.recordActivity({
            contact_id: doc.contact_id,
            user_id: principal.userId,
            details: { document_id: doc.id, filename: doc.original_filename, actor_role: actsAsClient ? 'client' : 'owner' },
            ip_address: self ? ip : null,
            user_agent: self ? (userAgent?.slice(0, 512) ?? null) : null,
          });
        } catch (err) {
          log.error('activity row failed', err);
        }
      }

      if (doc.encryption_status === 'none') {
        const url = await deps.signedUrl(doc.storage_path, SIGNED_URL_SECONDS);
        return json(200, { signed_url: url, filename: doc.original_filename, mime_type: doc.mime_type, mode: 'redirect' });
      }
      if (!doc.encryption_iv) throw new Error('encrypted row without an IV');

      const plaintext = await deps.decrypt(await deps.getObject(doc.storage_path), doc.encryption_iv);
      return new Response(plaintext as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(plaintext.byteLength) },
      });
    },
  });
}
