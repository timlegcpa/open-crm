// What a typed signature may contain: the characters EVERY script font has a glyph for.
//
// The six fonts are embedded whole with fontkit, so a character one of them lacks is
// drawn as .notdef: an empty or boxed signature on the executed PDF, silently, after the
// signer's link is spent. The allowed set is therefore the intersection of the six fonts'
// coverage, and src/__tests__/edge/esign-finalize-envelope.test.ts loads each TTF and checks every code
// point below against it. The signature modal applies the same rule (and offers "draw
// instead" when a name falls outside it).

/** Letters the six fonts all carry: ASCII, Latin-1 and the few Latin Extended-A they share. */
export const TYPED_SIGNATURE_LETTERS =
  'A-Za-zÀ-ÖØ-öø-ÿıŁłŒœŠšŸŽž';

/** Letters plus space, period, comma, apostrophe and hyphen; 1 to 80 characters. */
export const TYPED_SIGNATURE_PATTERN = new RegExp(`^[${TYPED_SIGNATURE_LETTERS} .,'-]{1,80}$`);
const HAS_LETTER = new RegExp(`[${TYPED_SIGNATURE_LETTERS}]`);

/** The typed signature as it will be stamped (NFC, trimmed), or null when it breaks the rule. */
export function normalizeTypedSignature(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').trim();
  if (!TYPED_SIGNATURE_PATTERN.test(text) || !HAS_LETTER.test(text)) return null;
  return text;
}

/** The script fonts, by the key the signer picks (the picker and the PDF stamp share these). */
export const SIGNATURE_FONT_FILES = {
  allison: 'Allison-Regular.ttf',
  dancing_script: 'DancingScript-Regular.ttf',
  great_vibes: 'GreatVibes-Regular.ttf',
  homemade_apple: 'HomemadeApple-Regular.ttf',
  pacifico: 'Pacifico-Regular.ttf',
  sacramento: 'Sacramento-Regular.ttf',
} as const;

export type SignerFontKey = keyof typeof SIGNATURE_FONT_FILES;

export function isSignerFontKey(value: unknown): value is SignerFontKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SIGNATURE_FONT_FILES, value);
}
