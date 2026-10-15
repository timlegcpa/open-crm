import { E164 } from '../contract';

/**
 * A signer's phone, for the SMS code of a high-verification envelope. It must be entered in
 * international form (+ and the country code): the server sends to exactly this number and
 * refuses anything else, and guessing a country from ten digits sends codes to the wrong
 * place for anyone outside it. Spaces, dashes, dots and brackets are allowed while typing
 * and stripped here.
 *
 * Returns the E.164 number, or undefined when the input is not one.
 */
export function toE164(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('+')) return undefined;
  const rest = trimmed.slice(1);
  if (/[^\d\s().-]/.test(rest)) return undefined;
  const candidate = `+${rest.replace(/\D/g, '')}`;
  return E164.test(candidate) ? candidate : undefined;
}
