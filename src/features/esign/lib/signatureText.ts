/**
 * What a TYPED signature may contain: the sign function's own rule, imported from it.
 *
 * The server stamps a typed signature onto the executed PDF in the chosen script font, and
 * a character that font has no glyph for is drawn as nothing: the signed copy would carry
 * a blank or broken signature, silently, after everyone has signed. So the rule is the
 * characters EVERY one of the six fonts can draw (TYPED_SIGNATURE_LETTERS, checked against
 * each TTF by the server's tests and parity.test.ts), and the signer page refuses anything
 * else before submit, offering "Draw instead". The module imported here has no imports of
 * its own, so this is the server's code in the browser, not a copy that can drift.
 */
import {
  normalizeTypedSignature,
  TYPED_SIGNATURE_LETTERS,
} from '../../../../supabase/functions/esign-finalize-envelope/lib/typed-signature';

export { normalizeTypedSignature, TYPED_SIGNATURE_LETTERS };

export const SIGNATURE_TEXT_MAX = 80;

const ALLOWED_CHAR = new RegExp(`^[${TYPED_SIGNATURE_LETTERS} .,'-]$`);
const HAS_LETTER = new RegExp(`[${TYPED_SIGNATURE_LETTERS}]`);

export type SignatureTextProblem = 'empty' | 'too_long' | 'unsupported';

/**
 * Why this typed signature cannot be used, or null when it can. It is null exactly when
 * the server's normalizeTypedSignature accepts the text (parity.test.ts); the reason is
 * for the hint under the field.
 */
export function signatureTextProblem(text: string): SignatureTextProblem | null {
  const trimmed = text.normalize('NFC').trim();
  if (trimmed === '') return 'empty';
  if ([...trimmed].length > SIGNATURE_TEXT_MAX) return 'too_long';
  for (const ch of trimmed) {
    if (!ALLOWED_CHAR.test(ch)) return 'unsupported';
  }
  if (!HAS_LETTER.test(trimmed)) return 'empty';
  return null;
}
