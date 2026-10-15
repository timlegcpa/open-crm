/**
 * Which consent disclosure the signer accepted. Sent with the consent click (view-pdf) and
 * with the signature, and recorded on the signer row and in the audit trail. Change this
 * string whenever the consent copy in public/signer/ConsentStep.tsx changes materially.
 * The server accepts only `^[A-Za-z0-9._-]{1,40}$`.
 */
export const ESIGN_CONSENT_DISCLOSURE_VERSION = '2026-10-15.v2';
