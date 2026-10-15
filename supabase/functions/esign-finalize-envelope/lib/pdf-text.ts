// Text that a pdf-lib StandardFont can always draw.
//
// StandardFonts (Helvetica) encode WinAnsi only and THROW on anything else. On the audit
// page that throw is irreversible: it happens after every signer has signed and their
// links are spent, so finalize would fail forever. Inputs there include signer-supplied
// text (consent version, time zone), real names, where an accented letter is ordinary,
// and the organization's own name.
//
// Characters the font cannot encode are folded to their unaccented base letter when one
// exists (NFKD), otherwise replaced with '?'. Pure: the caller passes the font's own
// encodability test, so this has no pdf-lib import and vitest runs it against the real
// font.


export function toEncodableText(text: string, canEncode: (s: string) => boolean): string {
  if (canEncode(text)) return text;
  let out = '';
  for (const ch of text) {
    if (canEncode(ch)) { out += ch; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += base && base !== ch && canEncode(base) ? base : '?';
  }
  return out;
}

/** The encodability test for a pdf-lib font: measuring encodes, and throws on failure. */
export function fontCanEncode(font: { widthOfTextAtSize: (t: string, s: number) => number }): (s: string) => boolean {
  return (s: string) => {
    try { font.widthOfTextAtSize(s, 1); return true; } catch { return false; }
  };
}
