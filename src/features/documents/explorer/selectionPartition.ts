/**
 * Which half of a client's documents does the current selection sit on, and
 * which of its rows are client-held?
 *
 * Kept out of `AdminDocumentsExplorer` so it can be tested: it decides which
 * bulk verbs the toolbar offers.
 *
 * Two answers, together because they are one partition:
 *
 *  - **Review and Move to shared are CLIENT-side verbs.** Inside a section every
 *    visible row is on one side, so the filter is a no-op there. At the client
 *    ROOT a selection can straddle both halves, and a shared row's null
 *    `reviewed_at` must not read as "needs review": the owner does not review
 *    their own files, so counting them would show work nobody owes.
 *  - **Bulk Move lists ONE section's folders as destinations.** A selection
 *    spanning both halves has no single destination tree, so it gets no Move
 *    button at all, rather than a dialog that quietly files shared rows into a
 *    client folder.
 */

/** The only field the partition reads. `held_by` is `'owner' | 'client'` in the database. */
export interface HeldRow {
  held_by: string;
}

export interface SelectionPartition<Folder extends HeldRow, File extends HeldRow> {
  /** Client-held folders in the selection. */
  clientFolders: Folder[];
  /** Client-held files in the selection. */
  clientFiles: File[];
  /**
   * The one half the whole selection sits on, or null when it straddles both.
   * An EMPTY selection is null too: there is no side to move to, and the
   * toolbar's Move button is gated on this being non-null.
   */
  heldBy: Folder['held_by'] | File['held_by'] | null;
}

export function partitionSelection<Folder extends HeldRow, File extends HeldRow>(
  folders: Folder[],
  files: File[],
): SelectionPartition<Folder, File> {
  const held = new Set<Folder['held_by'] | File['held_by']>();
  const clientFolders: Folder[] = [];
  const clientFiles: File[] = [];
  for (const folder of folders) {
    held.add(folder.held_by);
    if (folder.held_by === 'client') clientFolders.push(folder);
  }
  for (const file of files) {
    held.add(file.held_by);
    if (file.held_by === 'client') clientFiles.push(file);
  }
  return { clientFolders, clientFiles, heldBy: held.size === 1 ? [...held][0] : null };
}
