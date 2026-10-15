import type { HouseholdLink } from '@/api/contactRelationships';

/** What a share reads as when the person is no longer linked (or the links have not loaded). */
export const SHARED_WITH_UNKNOWN = 'another contact';

/** The name of the person a document is shared with, from the contact's links; null when not shared. */
export function sharedWithName(sharedContactId: string | null | undefined, links: readonly HouseholdLink[]): string | null {
  if (!sharedContactId) return null;
  return links.find((l) => l.otherId === sharedContactId)?.otherName ?? SHARED_WITH_UNKNOWN;
}
