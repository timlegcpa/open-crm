/**
 * What a TYPED signature may contain.
 *
 * The server stamps a typed signature onto the executed PDF in the chosen script font, and
 * a character that font has no glyph for is drawn as nothing: the signed copy would carry
 * a blank or broken signature, silently, after everyone has signed. So the rule is the
 * characters EVERY one of the six fonts can draw (signatureText.test.ts loads each TTF and
 * checks every character below), and the signer page refuses anything else before submit,
 * offering "Draw instead". The sign function enforces the same rule; keep the two equal.
 */

/** Every character a typed signature may use, besides the space. */
export const SIGNATURE_TEXT_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,'-" +
  'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöøùúûüýÿ';

export const SIGNATURE_TEXT_MAX = 80;

const ALLOWED = new Set([...SIGNATURE_TEXT_CHARS, ' ']);
const LETTER = /\p{L}/u;

export type SignatureTextProblem = 'empty' | 'too_long' | 'unsupported';

/** Why this typed signature cannot be used, or null when it can. Checks the trimmed text. */
export function signatureTextProblem(text: string): SignatureTextProblem | null {
  const trimmed = text.trim();
  if (trimmed === '' || !LETTER.test(trimmed)) return 'empty';
  if ([...trimmed].length > SIGNATURE_TEXT_MAX) return 'too_long';
  for (const ch of trimmed) {
    if (!ALLOWED.has(ch)) return 'unsupported';
  }
  return null;
}
