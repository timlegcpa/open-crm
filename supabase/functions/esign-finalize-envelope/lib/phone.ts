// A signer's phone for the SMS code: E.164 only, stored encrypted (ciphertext and IV in
// two bytea columns under PII_ENCRYPTION_KEY), shown everywhere as its last four digits.

/** E.164: a plus, a non-zero country code digit, then 6 to 14 more digits. */
export const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164.test(value);
}

export function lastFour(e164: string): string {
  return e164.slice(-4);
}

/** The masked form every page and the audit trail print. */
export function maskedPhone(last4: string | null): string {
  return last4 && /^\d{4}$/.test(last4) ? `•••• ${last4}` : '••••';
}

/**
 * The audit page's "Identity Check" line. Masked: the certificate goes to every signer,
 * so a co-signer must not read another signer's number. finalize and download-audit both
 * print it, so it is defined once here.
 */
export function identityCheckLine(s: { signed_verification_method: string | null; phone_last_four: string | null }): string {
  if (s.signed_verification_method !== 'email+sms') return 'Email Authentication';
  return `Email Authentication, and SMS (Text) Code sent to ${maskedPhone(s.phone_last_four)}`;
}

/** The audit page's "Consent" line, or undefined when the signer never consented. */
export function consentLine(s: { consented_at: string | null; consent_disclosure_version: string | null }): string | undefined {
  if (!s.consented_at) return undefined;
  return `Accepted ${s.consented_at}${s.consent_disclosure_version ? ` (disclosure ${s.consent_disclosure_version})` : ''}`;
}
