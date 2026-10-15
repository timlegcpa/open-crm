/**
 * "How many unreviewed items live under this folder?": the number behind the
 * badge on every folder row in the owner's documents explorer.
 *
 * Kept out of the component so it can be tested. Comparing every rendered folder
 * against every unreviewed item (`folders.length × items.length` `startsWith` calls)
 * on every refetch is quadratic; the bucketing below asks the question once.
 *
 * It is equivalent, not approximate: a candidate folder path is always built as
 * `${parent}${name}/`, so it always ends in a slash, and "does this item's path
 * start with that folder path" is therefore exactly "is that folder path one of
 * this item's slash-terminated prefixes".
 */

import { childPath } from '../lib/folderPath';

export interface UnreviewedDetail {
  docs: Array<{ folder_path: string }>;
  folders: Array<{ parent_path: string }>;
}

/**
 * Count unreviewed descendants per slash-terminated path prefix.
 *
 * Documents are bucketed by their own `folder_path` (a document sitting directly
 * in a folder counts for it), folders by their `parent_path` (never their own
 * path, because bucketing a folder under itself would conflate "this folder is
 * unreviewed" with "this folder contains N unreviewed items" under one badge).
 */
export function unreviewedPrefixCounts(detail: UnreviewedDetail | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!detail) return map;
  const bucket = (path: string) => {
    for (let i = 0; i < path.length; i++) {
      if (path[i] === '/') {
        const prefix = path.slice(0, i + 1);
        map.set(prefix, (map.get(prefix) ?? 0) + 1);
      }
    }
  };
  for (const doc of detail.docs) bucket(doc.folder_path);
  for (const sub of detail.folders) bucket(sub.parent_path);
  return map;
}

/** The path a folder row rendered at `currentPath` occupies. Always ends in '/'. */
export function folderPathAt(currentPath: string, name: string): string {
  return childPath(currentPath, name);
}

/** Badge count per folder id, from a prebuilt prefix map. One lookup per folder. */
export function countsByFolderId(
  prefixCounts: Map<string, number>,
  folders: Array<{ id: string; name: string }>,
  currentPath: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (prefixCounts.size === 0) return counts;
  for (const f of folders) {
    counts[f.id] = prefixCounts.get(folderPathAt(currentPath, f.name)) ?? 0;
  }
  return counts;
}
