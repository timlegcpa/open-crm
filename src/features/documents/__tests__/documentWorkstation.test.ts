import { describe, it, expect } from 'vitest';
import { documentKeys } from '../api';
import {
  toWorkstationDoc,
  folderLabel,
  groupDocsByFolder,
  flattenGroups,
  adjacentDocId,
  nextUnreviewedId,
  resolveShortcut,
  reconcileActiveId,
  type WorkstationDoc,
} from '../lib/documentWorkstation';

function doc(over: Partial<WorkstationDoc> & { id: string }): WorkstationDoc {
  return {
    name: over.id,
    mimeType: 'application/pdf',
    folderPath: '/',
    reviewedAt: null,
    createdAt: null,
    ...over,
  };
}

describe('toWorkstationDoc', () => {
  it('maps a full row', () => {
    expect(
      toWorkstationDoc({
        id: 'a',
        original_filename: 'W2.pdf',
        mime_type: 'application/pdf',
        folder_path: '/Statements/',
        reviewed_at: '2026-07-28T00:00:00Z',
        created_at: '2026-07-01T00:00:00Z',
      }),
    ).toEqual({
      id: 'a',
      name: 'W2.pdf',
      mimeType: 'application/pdf',
      folderPath: '/Statements/',
      reviewedAt: '2026-07-28T00:00:00Z',
      createdAt: '2026-07-01T00:00:00Z',
    });
  });

  it('tolerates null mime_type and folder_path', () => {
    const d = toWorkstationDoc({ id: 'a', original_filename: 'x', mime_type: null, folder_path: null });
    expect(d.mimeType).toBe('application/octet-stream');
    expect(d.folderPath).toBe('/');
    expect(d.reviewedAt).toBeNull();
  });
});

describe('folderLabel', () => {
  it('names the root', () => expect(folderLabel('/')).toBe('Root'));
  it('strips surrounding slashes', () =>
    expect(folderLabel('/Statements 2025/')).toBe('Statements 2025'));
  it('keeps inner slashes for nested paths', () =>
    expect(folderLabel('/Receipts/2025/')).toBe('Receipts/2025'));
});

describe('groupDocsByFolder', () => {
  it('puts root first, then folders A→Z', () => {
    const groups = groupDocsByFolder([
      doc({ id: '1', folderPath: '/Receipts/' }),
      doc({ id: '2', folderPath: '/' }),
      doc({ id: '3', folderPath: '/Bank/' }),
    ]);
    expect(groups.map((g) => g.folderPath)).toEqual(['/', '/Bank/', '/Receipts/']);
  });

  it('sorts by filename within a folder', () => {
    const groups = groupDocsByFolder([
      doc({ id: '1', name: 'zeta.pdf' }),
      doc({ id: '2', name: 'alpha.pdf' }),
    ]);
    expect(groups[0].docs.map((d) => d.name)).toEqual(['alpha.pdf', 'zeta.pdf']);
  });

  it('labels each group', () => {
    const groups = groupDocsByFolder([doc({ id: '1', folderPath: '/Bank/' })]);
    expect(groups[0].label).toBe('Bank');
  });

  it('returns nothing for an empty list', () => expect(groupDocsByFolder([])).toEqual([]));
});

describe('flattenGroups', () => {
  it('preserves display order across groups', () => {
    const ordered = flattenGroups(
      groupDocsByFolder([
        doc({ id: 'r1', name: 'b.pdf', folderPath: '/' }),
        doc({ id: 'f1', name: 'a.pdf', folderPath: '/Bank/' }),
        doc({ id: 'r2', name: 'a.pdf', folderPath: '/' }),
      ]),
    );
    expect(ordered.map((d) => d.id)).toEqual(['r2', 'r1', 'f1']);
  });
});

describe('adjacentDocId', () => {
  const ordered = [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })];

  it('moves forward and back', () => {
    expect(adjacentDocId(ordered, 'b', 1)).toBe('c');
    expect(adjacentDocId(ordered, 'b', -1)).toBe('a');
  });

  it('returns null at both ends: never wraps', () => {
    expect(adjacentDocId(ordered, 'c', 1)).toBeNull();
    expect(adjacentDocId(ordered, 'a', -1)).toBeNull();
  });

  it('returns null for an unknown id', () => expect(adjacentDocId(ordered, 'zz', 1)).toBeNull());
});

describe('nextUnreviewedId', () => {
  it('finds the next unreviewed after the current one', () => {
    const ordered = [
      doc({ id: 'a', reviewedAt: 'x' }),
      doc({ id: 'b' }),
      doc({ id: 'c' }),
    ];
    expect(nextUnreviewedId(ordered, 'b')).toBe('c');
  });

  it('skips reviewed documents', () => {
    const ordered = [doc({ id: 'a' }), doc({ id: 'b', reviewedAt: 'x' }), doc({ id: 'c' })];
    expect(nextUnreviewedId(ordered, 'a')).toBe('c');
  });

  it('wraps backwards when nothing unreviewed remains ahead', () => {
    const ordered = [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c', reviewedAt: 'x' })];
    expect(nextUnreviewedId(ordered, 'c')).toBe('a');
  });

  it('returns null when everything is reviewed', () => {
    const ordered = [doc({ id: 'a', reviewedAt: 'x' }), doc({ id: 'b', reviewedAt: 'x' })];
    expect(nextUnreviewedId(ordered, 'a')).toBeNull();
  });

  it('does not return the current document', () => {
    const ordered = [doc({ id: 'a' }), doc({ id: 'b', reviewedAt: 'x' })];
    expect(nextUnreviewedId(ordered, 'a')).toBeNull();
  });
});

describe('resolveShortcut', () => {
  const open = { inTextEntry: false, inOverlay: false };

  it('maps arrows to document and page moves', () => {
    expect(resolveShortcut({ key: 'ArrowDown', shiftKey: false }, open)).toEqual({ kind: 'doc', delta: 1 });
    expect(resolveShortcut({ key: 'ArrowUp', shiftKey: false }, open)).toEqual({ kind: 'doc', delta: -1 });
    expect(resolveShortcut({ key: 'ArrowRight', shiftKey: false }, open)).toEqual({ kind: 'page', delta: 1 });
    expect(resolveShortcut({ key: 'ArrowLeft', shiftKey: false }, open)).toEqual({ kind: 'page', delta: -1 });
  });

  it('advances on r and stays put on Shift+R', () => {
    expect(resolveShortcut({ key: 'r', shiftKey: false }, open)).toEqual({ kind: 'review', advance: true });
    expect(resolveShortcut({ key: 'R', shiftKey: true }, open)).toEqual({ kind: 'review', advance: false });
  });

  it('maps Escape', () =>
    expect(resolveShortcut({ key: 'Escape', shiftKey: false }, open)).toEqual({ kind: 'escape' }));

  it('ignores everything while typing in a text annotation', () => {
    const typing = { inTextEntry: true, inOverlay: false };
    expect(resolveShortcut({ key: 'r', shiftKey: false }, typing)).toBeNull();
    expect(resolveShortcut({ key: 'ArrowDown', shiftKey: false }, typing)).toBeNull();
    expect(resolveShortcut({ key: 'Escape', shiftKey: false }, typing)).toBeNull();
  });

  it('ignores everything while a dialog or menu owns the keys', () => {
    const overlay = { inTextEntry: false, inOverlay: true };
    expect(resolveShortcut({ key: 'Escape', shiftKey: false }, overlay)).toBeNull();
    expect(resolveShortcut({ key: 'r', shiftKey: false }, overlay)).toBeNull();
  });

  it('ignores unrelated keys', () =>
    expect(resolveShortcut({ key: 'k', shiftKey: false }, open)).toBeNull());
});

describe('reconcileActiveId', () => {
  const ordered = [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })];

  it('keeps a still-present id', () => expect(reconcileActiveId(ordered, 'b', 1)).toBe('b'));

  it('lands on whatever slid into the same slot when the id is gone', () => {
    expect(reconcileActiveId(ordered, 'deleted', 1)).toBe('b');
  });

  it('clamps a now-out-of-range index to the last document', () => {
    expect(reconcileActiveId(ordered, 'deleted', 9)).toBe('c');
  });

  it('falls back to the first document with no index hint', () => {
    expect(reconcileActiveId(ordered, 'deleted')).toBe('a');
  });

  it('returns null for an empty list', () => expect(reconcileActiveId([], 'a', 0)).toBeNull());

  it('returns the first document when there was no active id', () => {
    expect(reconcileActiveId(ordered, null)).toBe('a');
  });

  // ── Client switch (2026-08-05) ──
  // The header's client switcher changes `contactId` WITHOUT remounting the
  // shell, so both the active id and the remembered index survive into another
  // client's document list. These two cases are why DocumentWorkstation resets
  // lastIndexRef to -1 rather than only nulling the id.
  describe('after a client switch', () => {
    const clientB = [doc({ id: 'b1' }), doc({ id: 'b2' }), doc({ id: 'b3' })];

    it('THE HAZARD: a stale index silently selects an unrelated document', () => {
      // Client A's id is absent from B's list, so it falls through to the index
      // fallback: index 2 of A becomes B's THIRD document, chosen at random as
      // far as the user is concerned.
      expect(reconcileActiveId(clientB, 'a-doc-id', 2)).toBe('b3');
    });

    it('THE FIX: resetting the index to -1 lands on the new client\'s first document', () => {
      expect(reconcileActiveId(clientB, null, -1)).toBe('b1');
      // Belt and braces: even if the dead id lingers a render, -1 still wins.
      expect(reconcileActiveId(clientB, 'a-doc-id', -1)).toBe('b1');
    });
  });
});

describe('rail cache key', () => {
  // The whole invalidation story rests on prefix matching: every write invalidates
  // documentKeys.all, so the rail's keys MUST sit under the same root.
  it('the rail keys are prefix-covered by documentKeys.all', () => {
    const all = documentKeys.all;
    const section = [...documentKeys.forContact('contact-1'), 'client'];
    const folder = documentKeys.atPath('contact-1', '/Statements/', 'owner');
    expect(section.slice(0, all.length)).toEqual([...all]);
    expect(folder.slice(0, all.length)).toEqual([...all]);
  });
});
