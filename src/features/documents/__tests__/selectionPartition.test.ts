import { describe, it, expect } from 'vitest';
import { partitionSelection } from '../explorer/selectionPartition';

/**
 * The two things this guard stops, stated as the tests that break if it goes:
 *
 *  1. A shared row reaching Bulk Review or Move to shared. Shared files carry a
 *     null `reviewed_at` because nobody reviews them, so an unfiltered selection
 *     reports work that is not owed and then writes a review stamp onto the
 *     owner's own copy.
 *  2. A straddling selection opening Bulk Move. That dialog lists ONE section's
 *     folders as destinations, so a mixed selection would file shared rows into
 *     a client folder with no warning.
 *
 * Only reachable at the CONTACT ROOT, which is where both sections render together.
 */

const folder = (id: string, held_by: string) => ({ id, held_by });
const file = (id: string, held_by: string) => ({ id, held_by });

describe('partitionSelection', () => {
  it('an all-client selection is client-held and keeps every row', () => {
    const p = partitionSelection([folder('fo1', 'client')], [file('fi1', 'client'), file('fi2', 'client')]);
    expect(p.heldBy).toBe('client');
    expect(p.clientFolders.map((f) => f.id)).toEqual(['fo1']);
    expect(p.clientFiles.map((f) => f.id)).toEqual(['fi1', 'fi2']);
  });

  it('an all-shared selection is owner-held and yields NO client rows', () => {
    const p = partitionSelection([folder('fo1', 'owner')], [file('fi1', 'owner')]);
    expect(p.heldBy).toBe('owner');
    // Review and Move to shared read these two arrays. Empty means both verbs
    // no-op rather than stamping the owner's own copies as reviewed.
    expect(p.clientFolders).toEqual([]);
    expect(p.clientFiles).toEqual([]);
  });

  it('a straddling selection has NO side, so Bulk Move stays closed', () => {
    const p = partitionSelection([folder('fo1', 'owner')], [file('fi1', 'client')]);
    expect(p.heldBy).toBeNull();
  });

  it('straddling still hands the client rows through, and only those', () => {
    const p = partitionSelection(
      [folder('fo1', 'client'), folder('fo2', 'owner')],
      [file('fi1', 'owner'), file('fi2', 'client')],
    );
    expect(p.heldBy).toBeNull();
    expect(p.clientFolders.map((f) => f.id)).toEqual(['fo1']);
    expect(p.clientFiles.map((f) => f.id)).toEqual(['fi2']);
  });

  it('a selection straddling on FILES alone is caught, not just on folders', () => {
    const p = partitionSelection([], [file('fi1', 'client'), file('fi2', 'owner')]);
    expect(p.heldBy).toBeNull();
  });

  it('a selection straddling on FOLDERS alone is caught too', () => {
    const p = partitionSelection([folder('fo1', 'client'), folder('fo2', 'owner')], []);
    expect(p.heldBy).toBeNull();
  });

  it('an empty selection has no side', () => {
    const p = partitionSelection([], []);
    expect(p.heldBy).toBeNull();
    expect(p.clientFiles).toEqual([]);
    expect(p.clientFolders).toEqual([]);
  });

  it('does not mutate or reorder its inputs', () => {
    const folders = [folder('fo1', 'client')];
    const files = [file('fi1', 'client')];
    partitionSelection(folders, files);
    expect(folders.map((f) => f.id)).toEqual(['fo1']);
    expect(files.map((f) => f.id)).toEqual(['fi1']);
  });
});
