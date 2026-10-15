// esign-verify-document: the tamper check. Public, rate limited.
//
// The browser hashes the file and sends only the SHA-256 (the file never leaves the
// reader's machine). A digest that matches a completed envelope's executed copy, or the
// tombstone a deleted one left, is verified, with the title, the completion time and the
// signers' names and statuses: the hash is the capability, and whoever holds the file
// already holds all of that. Anything else is not verified, in words that accuse no one.
// The request must be application/json: a form post from another site cannot reach it.

import { createHandler, HttpError } from '../_shared/handler.ts';
import type { LogSink } from '../_shared/log.ts';
import { maybeOne, rows, type EsignDb } from '../esign-finalize-envelope/lib/db.ts';
import { badRequest, objectBody } from '../esign-finalize-envelope/lib/errors.ts';
import { publicLimits, type RateLimit } from '../esign-finalize-envelope/lib/signer-flow.ts';
import { resolveSignerName, SIGNER_CONTACT_COLUMNS, type SignerContact } from '../esign-finalize-envelope/lib/signer-name.ts';

export interface VerifyDocumentRequest {
  sha256: string;
}

export interface VerifiedSigner {
  name: string;
  status: string;
  signed_at: string | null;
}

export type VerifyDocumentResponse =
  | { verified: true; title: string; completed_at: string | null; sha256: string; signers: VerifiedSigner[] }
  | { verified: false; reason: string; sha256: string };

export const VERIFY_DOCUMENT_ERRORS = ['bad_request', 'unsupported_media_type', 'rate_limited'] as const;

export const NOT_VERIFIED_REASON =
  'No signed document on record matches this file. Either it was changed after signing, or it was not produced by this e-signature service.';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface VerifyDocumentDeps {
  allowedOrigins: string[];
  db: EsignDb;
  /** Default: 30 per address and 6000 in all per hour. */
  rateLimit?: RateLimit;
  logSink?: LogSink;
}

export function createVerifyDocumentHandler(deps: VerifyDocumentDeps): (req: Request) => Promise<Response> {
  const { db } = deps;
  return createHandler({
    name: 'esign-verify-document',
    allowedOrigins: deps.allowedOrigins,
    auth: { public: true },
    rateLimit: deps.rateLimit ?? publicLimits(db, 'esign_verify_document', { max: 30, windowMinutes: 60 }, { max: 6000, windowMinutes: 60 }),
    maxBodyBytes: 4_096,
    logSink: deps.logSink,
    async handle({ req, body, json }) {
      if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
        throw new HttpError(415, 'Send the fingerprint as JSON.', 'unsupported_media_type');
      }
      const raw = objectBody(body).sha256;
      const sha256 = typeof raw === 'string' ? raw.toLowerCase() : '';
      if (!SHA256_HEX.test(sha256)) throw badRequest('Send the SHA-256 fingerprint of the file as 64 hex characters.', 'bad_request');

      const envelope = await maybeOne<{ id: string; title: string; completed_at: string | null }>(
        'envelope read',
        db.from('esign_envelopes').select('id, title, completed_at').eq('signed_pdf_sha256', sha256).eq('status', 'completed').limit(1).maybeSingle(),
      );
      if (envelope) {
        const signers = await rows<{ order: number; email: string; role: string; status: string; signed_at: string | null; contact_id: string | null }>(
          'signer read',
          db.from('esign_envelope_signers').select('order, email, role, status, signed_at, contact_id').eq('envelope_id', envelope.id).order('order'),
        );
        const contactIds = [...new Set(signers.map((s) => s.contact_id).filter((id): id is string => !!id))];
        const contacts = contactIds.length
          ? await rows<SignerContact & { id: string }>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).in('id', contactIds))
          : [];
        const byId = new Map(contacts.map((c) => [c.id, c]));
        return json(200, {
          verified: true,
          title: envelope.title,
          completed_at: envelope.completed_at,
          sha256,
          signers: signers.map((s) => ({
            name: resolveSignerName({ email: s.email, role: s.role, contact: s.contact_id ? byId.get(s.contact_id) ?? null : null }),
            status: s.status,
            signed_at: s.signed_at,
          })),
        } satisfies VerifyDocumentResponse);
      }

      // A completed envelope that was deleted answers from its tombstone.
      const tomb = await maybeOne<{ title: string; completed_at: string | null; signers: unknown }>(
        'tombstone read',
        db
          .from('esign_completed_tombstones')
          .select('title, completed_at, signers')
          .eq('signed_pdf_sha256', sha256)
          .order('deleted_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      );
      if (tomb) {
        const list = Array.isArray(tomb.signers) ? (tomb.signers as Array<Record<string, unknown>>) : [];
        return json(200, {
          verified: true,
          title: tomb.title,
          completed_at: tomb.completed_at,
          sha256,
          signers: list.map((s) => ({
            name: typeof s.name === 'string' && s.name ? s.name : typeof s.email === 'string' ? s.email : 'Signer',
            status: typeof s.status === 'string' ? s.status : 'signed',
            signed_at: typeof s.signed_at === 'string' ? s.signed_at : null,
          })),
        } satisfies VerifyDocumentResponse);
      }
      return json(200, { verified: false, reason: NOT_VERIFIED_REASON, sha256 } satisfies VerifyDocumentResponse);
    },
  });
}
