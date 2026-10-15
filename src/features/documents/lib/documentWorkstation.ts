/**
 * Pure logic for the owner's document workstation (full-screen viewer + rail).
 *
 * Everything here is deliberately outside the React shell: document ordering,
 * the review sweep, keyboard intent, and active-id reconciliation are the parts
 * most likely to break subtly, and pulling them out as pure functions is what
 * makes them unit-testable without mounting the component tree.
 */

export interface WorkstationDoc {
  id: string;
  name: string;
  mimeType: string;
  folderPath: string;
  reviewedAt: string | null;
  createdAt: string | null;
}

export interface WorkstationGroup {
  folderPath: string;
  label: string;
  docs: WorkstationDoc[];
}

export type ShortcutAction =
  | { kind: 'doc'; delta: 1 | -1 }
  | { kind: 'page'; delta: 1 | -1 }
  | { kind: 'review'; advance: boolean }
  | { kind: 'escape' }
  | null;

const ROOT_PATH = '/';

/** `client_documents` row → the shape the workstation uses. Tolerates nulls. */
export function toWorkstationDoc(row: Record<string, unknown>): WorkstationDoc {
  return {
    id: String(row.id),
    name: (row.original_filename as string | null) ?? 'Untitled',
    mimeType: (row.mime_type as string | null) ?? 'application/octet-stream',
    folderPath: (row.folder_path as string | null) ?? ROOT_PATH,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  };
}

/** '/' → 'Root'; '/Statements 2025/' → 'Statements 2025'. */
export function folderLabel(folderPath: string): string {
  const trimmed = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? 'Root' : trimmed;
}

/**
 * Group by folder for the rail. Root first, then folders A→Z; within a folder,
 * filename A→Z. The order is deterministic on purpose: it IS the ↑/↓
 * traversal order, and a wobbling order would make arrow-key navigation
 * unpredictable between refetches.
 */
export function groupDocsByFolder(docs: WorkstationDoc[]): WorkstationGroup[] {
  const byPath = new Map<string, WorkstationDoc[]>();
  for (const doc of docs) {
    const list = byPath.get(doc.folderPath);
    if (list) list.push(doc);
    else byPath.set(doc.folderPath, [doc]);
  }

  const paths = [...byPath.keys()].sort((a, b) => {
    if (a === ROOT_PATH) return -1;
    if (b === ROOT_PATH) return 1;
    return a.localeCompare(b);
  });

  return paths.map((folderPath) => ({
    folderPath,
    label: folderLabel(folderPath),
    docs: [...(byPath.get(folderPath) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Display order flattened: the ↑/↓ traversal sequence. */
export function flattenGroups(groups: WorkstationGroup[]): WorkstationDoc[] {
  return groups.flatMap((g) => g.docs);
}

/**
 * Neighbour in traversal order. Returns null at either end: deliberately NO
 * wraparound: during a review sweep, silently looping back to the top re-shows
 * finished work and makes "am I done?" unanswerable.
 */
export function adjacentDocId(
  ordered: WorkstationDoc[],
  currentId: string,
  delta: 1 | -1,
): string | null {
  const index = ordered.findIndex((d) => d.id === currentId);
  if (index === -1) return null;
  const next = index + delta;
  if (next < 0 || next >= ordered.length) return null;
  return ordered[next].id;
}

/**
 * Next unreviewed document for the mark-and-advance sweep. Searches forward
 * first, then wraps to look before the current one. Wraparound IS wanted here
 * (unlike adjacentDocId): this is an explicit "find me more work" action, so
 * missing an unreviewed doc behind the cursor would strand it.
 * Returns null when nothing unreviewed remains.
 */
export function nextUnreviewedId(ordered: WorkstationDoc[], currentId: string): string | null {
  const index = ordered.findIndex((d) => d.id === currentId);
  const start = index === -1 ? 0 : index;

  for (let i = start + 1; i < ordered.length; i++) {
    if (ordered[i].reviewedAt === null) return ordered[i].id;
  }
  for (let i = 0; i < start; i++) {
    if (ordered[i].reviewedAt === null) return ordered[i].id;
  }
  return null;
}

/**
 * Keyboard intent. Returns null whenever another surface owns the keys , 
 * `inTextEntry` (the annotator's inline text-note textarea: typing "r" must not
 * mark the document reviewed) and `inOverlay` (an open dialog/menu: Escape must
 * close the dialog, not the workstation).
 */
export function resolveShortcut(
  e: { key: string; shiftKey: boolean },
  ctx: { inTextEntry: boolean; inOverlay: boolean },
): ShortcutAction {
  if (ctx.inTextEntry || ctx.inOverlay) return null;
  switch (e.key) {
    case 'ArrowDown':
      return { kind: 'doc', delta: 1 };
    case 'ArrowUp':
      return { kind: 'doc', delta: -1 };
    case 'ArrowRight':
      return { kind: 'page', delta: 1 };
    case 'ArrowLeft':
      return { kind: 'page', delta: -1 };
    case 'r':
    case 'R':
      return { kind: 'review', advance: !e.shiftKey };
    case 'Escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}

/**
 * Keep the active document valid across refetches. A document deleted
 * elsewhere, or a section switch, would otherwise leave the body fetching a
 * dead id.
 *
 * `previousIndex` is the position the active document held in the PREVIOUS
 * ordered list. Without it the only sane fallback is "jump to the top", which
 * is jarring when doc 7 of 20 is deleted mid-sweep; with it we land on the
 * document that slid into the same slot. Pass -1 (or omit) when unknown.
 */
export function reconcileActiveId(
  ordered: WorkstationDoc[],
  activeId: string | null,
  previousIndex = -1,
): string | null {
  if (ordered.length === 0) return null;
  if (activeId !== null && ordered.some((d) => d.id === activeId)) return activeId;
  if (previousIndex >= 0) {
    return ordered[Math.min(previousIndex, ordered.length - 1)].id;
  }
  return ordered[0].id;
}
