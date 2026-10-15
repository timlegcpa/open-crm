/**
 * THE '/Name/' convention shared by `client_folders.parent_path` and
 * `client_documents.folder_path`: root is `/`; a child of root is `/Name/`;
 * a nested child is `/A/B/`. Every path in this convention already ends in
 * '/', including root: that's what makes `childPath` a plain concatenation
 * rather than the "root vs. non-root" special case it replaces at seven call
 * sites across the admin documents explorer and annotator.
 */

/** The path a child named `name` occupies under `parent`. */
export function childPath(parent: string, name: string): string {
  return `${parent}${name}/`;
}

/** The parent of `path`. `parentOf('/')` is `/`: root has no parent. */
export function parentOf(path: string): string {
  if (path === '/') return '/';
  const trimmed = path.slice(0, -1);
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : trimmed.slice(0, lastSlash + 1);
}
