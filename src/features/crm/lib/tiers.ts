/**
 * Client tiers: the owner's hand-set ranking, S at the top, then A, B, C, D and E. Null is
 * "not ranked yet". A judgment the owner makes, never derived from revenue. The database
 * twin is the `contacts_tier_check` CHECK in 0013_crm.sql, pinned against this list by a
 * test in src/__tests__/db/contacts.test.ts.
 */
export const CLIENT_TIERS = ['S', 'A', 'B', 'C', 'D', 'E'] as const;
export type ClientTier = (typeof CLIENT_TIERS)[number];

export function isClientTier(v: unknown): v is ClientTier {
  return typeof v === 'string' && (CLIENT_TIERS as readonly string[]).includes(v);
}

/** "Not ranked": the Tiers board's last row, and the select option that clears a tier. */
export const UNRANKED = 'unranked' as const;
export type TierRowKey = ClientTier | typeof UNRANKED;

/** For the select fields. A select cannot hold an empty value, so "Not ranked" is UNRANKED. */
export const TIER_OPTIONS: Array<{ value: string; label: string }> = [
  ...CLIENT_TIERS.map((t) => ({ value: t as string, label: `${t} tier` })),
  { value: UNRANKED, label: 'Not ranked' },
];

/** What a select or a drop writes to `contacts.tier`: a tier, or null for anything else. */
export function tierValue(v: unknown): ClientTier | null {
  return isClientTier(v) ? v : null;
}

/**
 * People in tier rows, top tier first and "not ranked" last, each row sorted by name, the
 * id breaking a tie so the order never shuffles. Every row is returned, empty or not, so
 * the board keeps its shape and an empty tier is still a place to drop a card.
 */
export function groupByTier<T extends { id: string; tier?: string | null }>(
  people: readonly T[],
  nameOf: (p: T) => string,
): Array<{ key: TierRowKey; people: T[] }> {
  const rows = new Map<TierRowKey, T[]>([...CLIENT_TIERS, UNRANKED].map((k) => [k, []]));
  for (const p of people) rows.get(isClientTier(p.tier) ? p.tier : UNRANKED)!.push(p);
  return [...rows].map(([key, list]) => ({
    key,
    people: [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.id.localeCompare(b.id)),
  }));
}

/**
 * The tier-list colours: S red, A orange, B yellow, C green, D blue, E purple, each a
 * pastel under a dark letter. A fixed identity palette, the same in light and dark mode,
 * so these are not theme tokens: a tier's colour is what the tier IS, the way a status dot
 * is. The board's row labels and the record's tier mark share it, so the two never disagree.
 */
export const TIER_COLOR: Record<ClientTier, string> = {
  S: '#ff7f7f',
  A: '#ffbf7f',
  B: '#ffff7f',
  C: '#7fff7f',
  D: '#7fbfff',
  E: '#7f7fff',
};

/** The letter's ink on every tier colour: all six are light, in either theme. */
export const TIER_INK = '#1a1a1a';
