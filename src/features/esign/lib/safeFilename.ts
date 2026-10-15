/**
 * The name an envelope's PDF is saved under, everywhere: the owner's audit and signed-copy
 * downloads and the signer's unsigned copy. The server names the stored executed PDF with
 * the same rule (_shared/esign-safe-filename.ts); three diverging copies once saved one
 * signed PDF under three different names.
 *
 * Strips only what a filesystem cannot hold and caps at 200 characters. Spaces, commas and
 * non-ASCII survive on purpose: the title is what the signer recognises.
 *
 * The doubled backslash in the class is load-bearing: a single one would escape the colon
 * after it, and literal backslashes would stop being stripped.
 */
export function esignSafeFilename(title: string): string {
  return title.replace(/[/\\:*?"<>|]+/g, '_').slice(0, 200);
}
