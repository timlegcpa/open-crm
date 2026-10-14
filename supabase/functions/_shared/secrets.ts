// Shared-secret checks for callers that carry no user session: pg_cron (the
// x-cron-secret header) and one edge function calling another (a header the two agree
// on). A custom header, because the Supabase gateway rewrites a service-role bearer on
// its way to a function, so a bearer comparison against the service key never matches.
//
// Fail closed: an unset or short configured secret refuses every caller, so a missing
// environment value can never turn a check into "allow".

/** The shortest configured secret accepted. `npm run dev:bootstrap` writes 64 hex characters. */
export const MIN_SECRET_LENGTH = 32;

/** The header pg_cron jobs send CRON_SHARED_SECRET in. */
export const CRON_SECRET_HEADER = 'x-cron-secret';

/**
 * Constant-time string comparison, byte-wise over UTF-8. A length mismatch still burns
 * a full pass over the presented value, so the cost of a wrong guess does not depend on
 * how close its length was.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    let sink = 0;
    for (let i = 0; i < ab.length; i++) sink |= ab[i];
    return sink === -1;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** True only when a configured secret of usable length equals the presented one. */
export function secretMatches(presented: string | null | undefined, configured: string | null | undefined): boolean {
  if (!configured || configured.length < MIN_SECRET_LENGTH) return false;
  if (!presented) return false;
  return timingSafeEqual(presented, configured);
}

/** The pg_cron check: `x-cron-secret` against CRON_SHARED_SECRET. */
export function verifyCronSecret(req: Request, configured: string | null | undefined): boolean {
  return secretMatches(req.headers.get(CRON_SECRET_HEADER), configured);
}

/** A function-to-function check: the named header against the named secret's value. */
export function verifyInternalSecret(req: Request, header: string, configured: string | null | undefined): boolean {
  return secretMatches(req.headers.get(header), configured);
}
