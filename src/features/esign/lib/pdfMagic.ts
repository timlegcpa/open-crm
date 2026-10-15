/**
 * Does this file start like a PDF? A courtesy check so the owner (or a person verifying a
 * signed copy) hears about a wrong file at once. It is not a guard: the server reads the
 * bytes again and decides.
 */
export async function looksLikePdf(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  // "%PDF-"
  return head.length === 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

/** Lowercase hex SHA-256 of the bytes, computed in the browser. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
