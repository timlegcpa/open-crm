// How a public signer function finds its signer: the link token's SHA-256 against the
// stored hash, then the envelope, and for a 'high' envelope the IP-pinned SMS session.

import { sha256Hex } from '../../_shared/crypto.ts';
import { maybeOne, type EsignDb, type Row } from './db.ts';
import { isTokenShape } from './text.ts';

/** The signer whose link this token is, or null (unknown token, or not a token at all). */
export async function signerByToken<T = Row>(db: EsignDb, token: unknown, columns: string): Promise<T | null> {
  if (!isTokenShape(token)) return null;
  const hash = await sha256Hex(token);
  const res = await db.from('esign_envelope_signers').select(columns).eq('token_hash', hash).maybeSingle();
  // More than one row for one hash cannot happen with 256-bit tokens; treat it as unknown.
  if (res.error) return null;
  return (res.data ?? null) as T | null;
}

export async function envelopeById<T = Row>(db: EsignDb, id: string, columns: string): Promise<T | null> {
  return await maybeOne<T>('envelope read', db.from('esign_envelopes').select(columns).eq('id', id).maybeSingle());
}

/** True when the link has expired (or never had a deadline). */
export function linkExpired(tokenExpiresAt: string | null, now: Date): boolean {
  return !tokenExpiresAt || Date.parse(tokenExpiresAt) <= now.getTime();
}

/**
 * A live SMS session for this signer, opened from this address. The address is compared
 * by the database (inet equality), so two spellings of one IPv6 address match.
 * Without an address there is nothing to pin to, so there is no session.
 */
export async function hasLiveSession(
  db: EsignDb,
  opts: { signerId: string; sessionToken: unknown; ip: string | null; now: Date },
): Promise<boolean> {
  if (!opts.ip || !isTokenShape(opts.sessionToken)) return false;
  const hash = await sha256Hex(opts.sessionToken);
  const row = await maybeOne(
    'signer session read',
    db
      .from('esign_signer_sessions')
      .select('id')
      .eq('session_token_hash', hash)
      .eq('signer_id', opts.signerId)
      .eq('ip', opts.ip)
      .gt('expires_at', opts.now.toISOString())
      .maybeSingle(),
  );
  return row !== null;
}

export const LIVE_ENVELOPE = ['sent', 'partially_signed'] as const;
export const SIGNABLE_SIGNER = ['invited', 'viewed'] as const;

export const isLiveEnvelope = (status: string) => (LIVE_ENVELOPE as readonly string[]).includes(status);
export const isSignableSigner = (status: string) => (SIGNABLE_SIGNER as readonly string[]).includes(status);

/** The finalize trigger sign and expiry use: POST to the function with the internal token. */
export type FinalizeTrigger = (envelopeId: string) => Promise<boolean>;

export function createFinalizeTrigger(opts: {
  fetch: typeof fetch;
  supabaseUrl: string;
  internalToken: string | null | undefined;
  timeoutMs: number;
  onError?: (event: string, err?: unknown) => void;
}): FinalizeTrigger {
  const url = `${opts.supabaseUrl.replace(/\/+$/, '')}/functions/v1/esign-finalize-envelope`;
  return async (envelopeId) => {
    if (!opts.internalToken) {
      opts.onError?.('ESIGN_INTERNAL_TOKEN is not set; finalize skipped');
      return false;
    }
    try {
      const res = await opts.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': opts.internalToken },
        body: JSON.stringify({ envelope_id: envelopeId }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      await res.body?.cancel();
      if (!res.ok) opts.onError?.(`finalize answered ${res.status}`);
      return res.ok;
    } catch (err) {
      opts.onError?.('finalize call failed', err);
      return false;
    }
  };
}
