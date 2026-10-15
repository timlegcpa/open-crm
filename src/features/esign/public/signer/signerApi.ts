import { edgeErrorFromResponse } from '@/lib/edgeCore';
import { invokePublicEdge, publicEdgeFetch } from '@/lib/publicEdge';
import {
  FN,
  requestSmsAnswer,
  resolveTokenAnswer,
  verifySmsAnswer,
  type AdoptedSignature,
  type ResolveTokenAnswer,
  type SignRequest,
  type VerifySmsAnswer,
} from '../../contract';
import { ESIGN_CONSENT_DISCLOSURE_VERSION } from '../../lib/consentVersion';

/**
 * The signer's calls. Public: no session, no supabase-js; the signing token in the body is
 * the whole capability. A 401 from view-pdf, sign or decline means the High verification
 * session is missing or expired, and is returned as a value so the flow can go back to the
 * text-code step rather than show an error.
 */

export const SESSION_EXPIRED = 'session_expired' as const;
export type SessionExpired = typeof SESSION_EXPIRED;

export function resolveToken(token: string): Promise<ResolveTokenAnswer> {
  return invokePublicEdge(FN.resolveToken, { token }, { parse: (d) => resolveTokenAnswer.parse(d) });
}

export async function requestSmsCode(token: string): Promise<string | null> {
  const answer = await invokePublicEdge(FN.requestSms, { token }, { parse: (d) => requestSmsAnswer.parse(d) });
  return answer.last_four ?? null;
}

export function verifySmsCode(token: string, code: string): Promise<VerifySmsAnswer> {
  return invokePublicEdge(FN.verifySms, { token, code }, { parse: (d) => verifySmsAnswer.parse(d) });
}

/**
 * The assembled PDF. Asking for it records the consent click (first acceptance only), so it
 * is called only after the signer agreed. The bytes come back as an ArrayBuffer the caller
 * owns: pdf.js detaches what it is given, so copy before handing it over.
 */
export async function viewPdf(token: string, sessionToken: string | null): Promise<ArrayBuffer | SessionExpired> {
  const res = await publicEdgeFetch(FN.viewPdf, {
    method: 'POST',
    body: { token, session_token: sessionToken ?? undefined, consent: true, consent_version: ESIGN_CONSENT_DISCLOSURE_VERSION },
    headers: { Accept: 'application/pdf' },
  });
  if (res.status === 401) return SESSION_EXPIRED;
  if (!res.ok) throw await edgeErrorFromResponse(res);
  return res.arrayBuffer();
}

/** The sign request for what the signer adopted: typed and drawn are exclusive on the wire. */
export function buildSignRequest(token: string, signature: AdoptedSignature, sessionToken: string | null, timezone: string): SignRequest {
  return {
    token,
    kind: signature.kind,
    ...(signature.kind === 'typed'
      ? { signature_text: signature.signature_text, font_key: signature.font_key }
      : { signature_image: signature.image_base64 }),
    timezone,
    consent: true,
    consent_version: ESIGN_CONSENT_DISCLOSURE_VERSION,
    ...(sessionToken ? { session_token: sessionToken } : {}),
  };
}

export async function sign(request: SignRequest): Promise<'ok' | SessionExpired> {
  const res = await publicEdgeFetch(FN.sign, { method: 'POST', body: request });
  if (res.status === 401) return SESSION_EXPIRED;
  if (!res.ok) throw await edgeErrorFromResponse(res);
  return 'ok';
}

export async function decline(token: string, sessionToken: string | null, reason: string): Promise<'ok' | SessionExpired> {
  const res = await publicEdgeFetch(FN.decline, {
    method: 'POST',
    body: { token, session_token: sessionToken ?? undefined, reason: reason.trim() || undefined },
  });
  if (res.status === 401) return SESSION_EXPIRED;
  if (!res.ok) throw await edgeErrorFromResponse(res);
  return 'ok';
}

/** The signer's IANA time zone, for the stamp; UTC when the browser will not say. */
export function signerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
