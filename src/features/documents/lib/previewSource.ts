/**
 * Reading a decrypted document preview WITHOUT fetching a `blob:` URL.
 *
 * A production CSP usually allows `blob:` in `img-src` and `frame-src` but
 * not in `connect-src`, so `fetch(URL.createObjectURL(blob))` is
 * blocked in production and works everywhere else: the dev server sends no
 * CSP and jsdom enforces none. That asymmetry once shipped a docx preview
 * that worked everywhere but production; the PDF iframe and image previews
 * never showed it, because `img-src`/`frame-src` allow `blob:`.
 *
 * `previewDocument` (../api.ts) already holds the decrypted Blob, so
 * re-fetching its own object URL was a round trip for bytes we have. Read the
 * Blob directly. Only redirect mode (plaintext rows) has no Blob, and its
 * signed Storage URL is allowed by `connect-src`.
 *
 * Any renderer that needs a preview's contents uses these.
 */

/**
 * `response.ok` is checked because the redirect path fetches a SIGNED URL, and
 * an expired or forbidden one comes back as a 403 carrying an XML error body,
 * not as a network failure. Unchecked, `readPreviewText` hands that XML to the
 * renderer as the document's contents: `CsvRenderer` parses it into a table of
 * nonsense rows and the viewer shows a plausible-looking document that is
 * actually Storage's error page. `documentBytes` in ../api.ts guards the same.
 */
async function fetchPreview(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Preview failed');
  return response;
}

/** Preview bytes, from the in-memory Blob when there is one. */
export async function readPreviewBytes(url: string, blob?: Blob): Promise<ArrayBuffer> {
  if (blob) return blob.arrayBuffer();
  return (await fetchPreview(url)).arrayBuffer();
}

/** Preview text, from the in-memory Blob when there is one. */
export async function readPreviewText(url: string, blob?: Blob): Promise<string> {
  if (blob) return blob.text();
  return (await fetchPreview(url)).text();
}
