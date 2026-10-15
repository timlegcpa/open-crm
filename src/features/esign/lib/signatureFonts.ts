/**
 * The six script fonts a typed signature can use. Keys are what the signer page sends and
 * what the sign function accepts; `ttf` is the file under
 * supabase/functions/_shared/esign-fonts/fonts/ the server stamps with, and `family` is the
 * @font-face name in ../fonts/signatureFonts.css that the browser previews with. The three
 * lists are held equal by signatureFonts.test.ts.
 *
 * Tile sizes differ per font on purpose: these faces have very different glyph heights at
 * the same em size, so one size either shrinks the compact ones or clips the tall ones.
 */
export interface SignatureFont {
  key: string;
  family: string;
  label: string;
  ttf: string;
  /** The browser's copy, in ../fonts/. */
  woff2: string;
  tilePx: number;
  tileLh: number;
}

export const SIGNATURE_FONTS: readonly SignatureFont[] = [
  { key: 'allison', family: "'Allison', cursive", label: 'Allison', ttf: 'Allison-Regular.ttf', woff2: 'allison.woff2', tilePx: 38, tileLh: 1.3 },
  { key: 'dancing_script', family: "'Dancing Script', cursive", label: 'Dancing Script', ttf: 'DancingScript-Regular.ttf', woff2: 'dancing-script.woff2', tilePx: 30, tileLh: 1.4 },
  { key: 'sacramento', family: "'Sacramento', cursive", label: 'Sacramento', ttf: 'Sacramento-Regular.ttf', woff2: 'sacramento.woff2', tilePx: 34, tileLh: 1.4 },
  { key: 'great_vibes', family: "'Great Vibes', cursive", label: 'Great Vibes', ttf: 'GreatVibes-Regular.ttf', woff2: 'great-vibes.woff2', tilePx: 34, tileLh: 1.5 },
  { key: 'pacifico', family: "'Pacifico', cursive", label: 'Pacifico', ttf: 'Pacifico-Regular.ttf', woff2: 'pacifico.woff2', tilePx: 26, tileLh: 1.5 },
  { key: 'homemade_apple', family: "'Homemade Apple', cursive", label: 'Homemade Apple', ttf: 'HomemadeApple-Regular.ttf', woff2: 'homemade-apple.woff2', tilePx: 22, tileLh: 1.7 },
];

export function fontFamilyForKey(key: string): string {
  return SIGNATURE_FONTS.find((f) => f.key === key)?.family ?? SIGNATURE_FONTS[0].family;
}

/** The ink every signature is drawn and previewed in: a fixed near-black, never a theme colour. */
export const SIGNATURE_INK = '#111827';
