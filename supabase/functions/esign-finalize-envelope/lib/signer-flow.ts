// What every public signer function does first: the rate limit, then the signer the link
// token names, its envelope, and for a 'high' envelope the SMS session.
//
// A link that is unknown, expired, spent or on an envelope that is no longer live answers
// one 404 (linkNotFound): the endpoint never says which, so a guessed token learns nothing.

import type { RequestContext } from '../../_shared/handler.ts';
import { checkPublicLimits, type Limit, type RateLimitOutcome } from '../../_shared/rate-limit.ts';
import { maybeOne, type EsignDb } from './db.ts';
import { linkNotFound, sessionRequired } from './errors.ts';
import { SIGNER_CONTACT_COLUMNS, type SignerContact } from './signer-name.ts';
import { envelopeById, hasLiveSession, isLiveEnvelope, isSignableSigner, linkExpired, signerByToken } from './signer-access.ts';

export type RateLimit = (ctx: RequestContext) => Promise<RateLimitOutcome>;

/** The per-address and shared buckets of one public action, in one database call. */
export function publicLimits(db: EsignDb, action: string, perIp: Limit, global: Limit): RateLimit {
  return ({ ip, userAgent }) => checkPublicLimits(db, { action, ip, userAgent, perIp, global });
}

export interface SignableSigner {
  id: string;
  envelope_id: string;
  contact_id: string | null;
  email: string;
  role: string;
  status: string;
  token_expires_at: string | null;
  client_task_id: string | null;
  first_viewed_at: string | null;
  consented_at: string | null;
  phone_last_four: string | null;
  signed_at: string | null;
  opened_email_at: string | null;
}

export interface SignableEnvelope {
  id: string;
  title: string;
  status: string;
  verification_level: 'standard' | 'high';
  source_pdf_path: string | null;
}

const SIGNER_COLUMNS =
  'id, envelope_id, contact_id, email, role, status, token_expires_at, client_task_id, first_viewed_at, consented_at, phone_last_four, signed_at, opened_email_at';
const ENVELOPE_COLUMNS = 'id, title, status, verification_level, source_pdf_path';

/** The signer and envelope a token names, whatever their state (null when the token is unknown). */
export async function loadByToken(
  db: EsignDb,
  token: unknown,
): Promise<{ signer: SignableSigner; envelope: SignableEnvelope } | null> {
  const signer = await signerByToken<SignableSigner>(db, token, SIGNER_COLUMNS);
  if (!signer) return null;
  const envelope = await envelopeById<SignableEnvelope>(db, signer.envelope_id, ENVELOPE_COLUMNS);
  if (!envelope) return null;
  return { signer, envelope };
}

/** True when the pair can act now: link unexpired, signer invited or viewed, envelope live. */
export function isSignableNow(signer: SignableSigner, envelope: SignableEnvelope, now: Date): boolean {
  return !linkExpired(signer.token_expires_at, now) && isSignableSigner(signer.status) && isLiveEnvelope(envelope.status);
}

/** The signable pair, or the one 404. */
export async function requireSignable(
  db: EsignDb,
  token: unknown,
  now: Date,
): Promise<{ signer: SignableSigner; envelope: SignableEnvelope }> {
  const found = await loadByToken(db, token);
  if (!found || !isSignableNow(found.signer, found.envelope, now)) throw linkNotFound();
  return found;
}

/** A 'high' envelope's signer must hold a live SMS session opened from this address. */
export async function requireSessionIfHigh(
  db: EsignDb,
  opts: { envelope: SignableEnvelope; signerId: string; sessionToken: unknown; ip: string | null; now: Date },
): Promise<'email' | 'email+sms'> {
  if (opts.envelope.verification_level !== 'high') return 'email';
  const live = await hasLiveSession(db, { signerId: opts.signerId, sessionToken: opts.sessionToken, ip: opts.ip, now: opts.now });
  if (!live) throw sessionRequired();
  return 'email+sms';
}

/** The signer's linked contact, for its name (null when unlinked or gone). */
export async function signerContact(db: EsignDb, contactId: string | null): Promise<SignerContact | null> {
  if (!contactId) return null;
  return await maybeOne<SignerContact>('contact read', db.from('contacts').select(SIGNER_CONTACT_COLUMNS).eq('id', contactId).maybeSingle());
}

export type TerminalState = 'already_signed' | 'declined' | 'co_signer_declined' | 'voided' | 'expired';

/**
 * Why a link the holder really owns cannot be signed, or null when it can. The holder is
 * the addressee, so naming the reason leaks nothing. Order matters: a co-signer whose link
 * died because someone else declined has an expired row, so the declines come first, and
 * a declined envelope is not "cancelled by the sender".
 */
export function terminalState(signer: SignableSigner, envelope: SignableEnvelope, now: Date): TerminalState | null {
  if (signer.status === 'signed' || signer.signed_at || envelope.status === 'completed') return 'already_signed';
  if (signer.status === 'declined') return 'declined';
  if (envelope.status === 'declined') return 'co_signer_declined';
  if (envelope.status === 'voided') return 'voided';
  if (envelope.status === 'expired' || signer.status === 'expired' || linkExpired(signer.token_expires_at, now)) return 'expired';
  return null;
}
