/**
 * Hand an in-memory Blob to the browser as a download. The one home of the object-URL
 * dance: create, click a temporary link, revoke.
 *
 * The link is attached to the document while it is clicked (Firefox ignores a click on a
 * detached anchor) and the URL is revoked on the next tick rather than immediately, which
 * some browsers treat as cancelling the download.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
