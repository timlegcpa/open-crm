import { describe, it, expect } from 'vitest';
import {
  unreviewedPrefixCounts,
  countsByFolderId,
  folderPathAt,
  type UnreviewedDetail,
} from '../explorer/unreviewedDescendantCounts';

/**
 * The reference implementation this replaced: for each rendered folder, count
 * every unreviewed item whose path starts with that folder's path. Kept here as
 * the oracle so the fast version is pinned to the behavior it inherited, not to
 * one reading of it.
 */
function referenceCounts(
  detail: UnreviewedDetail,
  folders: Array<{ id: string; name: string }>,
  currentPath: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of folders) {
    const folderPath = folderPathAt(currentPath, f.name);
    let count = 0;
    for (const doc of detail.docs) if (doc.folder_path.startsWith(folderPath)) count++;
    for (const sub of detail.folders) if (sub.parent_path.startsWith(folderPath)) count++;
    counts[f.id] = count;
  }
  return counts;
}

const fast = (
  detail: UnreviewedDetail,
  folders: Array<{ id: string; name: string }>,
  currentPath: string,
) => countsByFolderId(unreviewedPrefixCounts(detail), folders, currentPath);

describe('unreviewedDescendantCounts', () => {
  it('counts a document sitting directly in the folder', () => {
    const detail: UnreviewedDetail = { docs: [{ folder_path: '/Contracts/' }], folders: [] };
    expect(fast(detail, [{ id: 'f1', name: 'Contracts' }], '/')).toEqual({ f1: 1 });
  });

  it('counts documents nested any number of levels deep', () => {
    const detail: UnreviewedDetail = {
      docs: [
        { folder_path: '/Contracts/' },
        { folder_path: '/Contracts/2025/' },
        { folder_path: '/Contracts/2025/Signed/' },
      ],
      folders: [],
    };
    expect(fast(detail, [{ id: 'f1', name: 'Contracts' }], '/')).toEqual({ f1: 3 });
  });

  it('counts unreviewed subfolders by their parent, so a folder never counts itself', () => {
    // The unreviewed folder IS /Contracts/: its own parent_path is '/'. Under the
    // badge for /Contracts/ it must not appear, or "this folder is unreviewed" and
    // "this folder contains an unreviewed item" become the same number.
    const detail: UnreviewedDetail = { docs: [], folders: [{ parent_path: '/' }] };
    expect(fast(detail, [{ id: 'f1', name: 'Contracts' }], '/')).toEqual({ f1: 0 });
  });

  it('counts an unreviewed subfolder under its ancestor', () => {
    const detail: UnreviewedDetail = { docs: [], folders: [{ parent_path: '/Contracts/2025/' }] };
    expect(fast(detail, [{ id: 'f1', name: 'Contracts' }], '/')).toEqual({ f1: 1 });
  });

  it('does not let a sibling with a shared name prefix leak in', () => {
    // '/Contract' is a string prefix of '/Contracts/…': the trailing slash on the folder
    // path is what keeps "Contract" and "Contracts" apart, in both implementations.
    const detail: UnreviewedDetail = { docs: [{ folder_path: '/Contracts/2025/' }], folders: [] };
    expect(fast(detail, [{ id: 'f1', name: 'Contract' }], '/')).toEqual({ f1: 0 });
  });

  it('scopes to the current path when browsing below the root', () => {
    const detail: UnreviewedDetail = {
      docs: [{ folder_path: '/Contracts/2025/' }, { folder_path: '/Other/2025/' }],
      folders: [],
    };
    expect(fast(detail, [{ id: 'f1', name: '2025' }], '/Contracts/')).toEqual({ f1: 1 });
  });

  it('returns zero for a folder with nothing under it', () => {
    const detail: UnreviewedDetail = { docs: [{ folder_path: '/Contracts/' }], folders: [] };
    expect(fast(detail, [{ id: 'f1', name: 'Empty' }], '/')).toEqual({ f1: 0 });
  });

  it('returns an empty map for a client with no unreviewed items', () => {
    expect(unreviewedPrefixCounts(undefined).size).toBe(0);
    expect(countsByFolderId(new Map(), [{ id: 'f1', name: 'Contracts' }], '/')).toEqual({});
  });

  it('agrees with the reference implementation on a realistic tree', () => {
    const detail: UnreviewedDetail = {
      docs: [
        { folder_path: '/' },
        { folder_path: '/Contracts/' },
        { folder_path: '/Contracts/' },
        { folder_path: '/Contracts/2025/' },
        { folder_path: '/Contracts/2025/Signed/' },
        { folder_path: '/Contracts/2024/' },
        { folder_path: '/Projects/' },
        { folder_path: '/Projects/Receipts/Q1/' },
        { folder_path: '/Contract/' },
      ],
      folders: [
        { parent_path: '/' },
        { parent_path: '/Contracts/' },
        { parent_path: '/Contracts/2025/' },
        { parent_path: '/Projects/Receipts/' },
      ],
    };
    const folders = [
      { id: 'a', name: 'Contracts' },
      { id: 'b', name: 'Projects' },
      { id: 'c', name: 'Contract' },
      { id: 'd', name: 'Nothing' },
    ];
    expect(fast(detail, folders, '/')).toEqual(referenceCounts(detail, folders, '/'));
    // Pinned literally too: an oracle that is wrong in the same way is no oracle.
    // Contracts: 5 docs (2 direct, 3 nested) + 2 subfolders. Projects: 2 docs + 1
    // subfolder. Contract: its own 1 doc and nothing of Contracts'.
    expect(fast(detail, folders, '/')).toEqual({ a: 7, b: 3, c: 1, d: 0 });
  });
});
