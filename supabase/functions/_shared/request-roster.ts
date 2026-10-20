// The requests roster: every request in one list, grouped by whose move it is. One source
// for the browser (src/features/requests imports this file) and for any edge function that
// lists requests, so a screen and a server answer cannot disagree about what is waiting on
// whom. Pure: no Deno global, no imports.
//
//   Waiting on you     a list the client submitted, or a sent list with an answer to accept
//   Waiting on client  a sent list with nothing to accept
//   Drafts             a list not sent yet
//   Archived           a closed list (a list closes itself once every answer is accepted,
//                      0014_requests; screens fold this section away until asked)
//
// "An answer to accept" is an actionable item (any kind but info) whose status is
// 'fulfilled': the same test the database's auto-close uses, read from raw rows, so a
// caller needs no fulfilment rule of its own. A status outside the known ones gets a section
// of its own at the end rather than vanishing; its key is prefixed so it can never land in a
// known section that happens to share its name.

export interface RosterList {
  id: string;
  status: string;
  contact_id: string;
  created_at: string;
  items: ReadonlyArray<{ kind: string; status: string }>;
}

export interface RosterSection<L> {
  key: string;
  label: string;
  rows: L[];
}

/** The section the screens fold away until asked. */
export const ARCHIVED_SECTION = 'archived';

const SECTIONS = [
  { key: 'yours', label: 'Waiting on you' },
  { key: 'client', label: 'Waiting on client' },
  { key: 'drafts', label: 'Drafts' },
  { key: ARCHIVED_SECTION, label: 'Archived' },
] as const;

const OTHER = 'other:';

/** Answered items waiting on the owner's accept, by raw status. */
export function answersToAccept(list: Pick<RosterList, 'items'>): number {
  return list.items.filter((i) => i.kind !== 'info' && i.status === 'fulfilled').length;
}

function sectionOf(list: RosterList): string {
  switch (list.status) {
    case 'submitted':
      return 'yours';
    case 'sent':
      return answersToAccept(list) > 0 ? 'yours' : 'client';
    case 'draft':
      return 'drafts';
    case 'closed':
      return ARCHIVED_SECTION;
    default:
      return `${OTHER}${list.status}`;
  }
}

/**
 * The roster's sections in order, empty ones dropped. Inside a section rows run A to Z by
 * the client's name, then newest first, then by id, so the order never depends on how the
 * rows were read.
 */
export function requestRosterSections<L extends RosterList>(
  lists: readonly L[],
  nameOf: (contactId: string) => string,
): Array<RosterSection<L>> {
  const byKey = new Map<string, L[]>();
  for (const list of lists) {
    const key = sectionOf(list);
    const bucket = byKey.get(key) ?? [];
    bucket.push(list);
    byKey.set(key, bucket);
  }
  const order = (rows: L[]) =>
    rows
      .map((row) => ({ row, name: nameOf(row.contact_id).toLowerCase() }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          (a.row.created_at < b.row.created_at ? 1 : a.row.created_at > b.row.created_at ? -1 : 0) ||
          (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
      )
      .map((x) => x.row);
  const known = SECTIONS.map((s) => ({ key: s.key as string, label: s.label as string, rows: byKey.get(s.key) ?? [] }));
  const other = [...byKey]
    .filter(([key]) => key.startsWith(OTHER))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rows]) => ({ key, label: key.slice(OTHER.length), rows }));
  return [...known, ...other].filter((s) => s.rows.length > 0).map((s) => ({ ...s, rows: order(s.rows) }));
}
