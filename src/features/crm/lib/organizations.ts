/**
 * Organization status moves the CRM allows. There is no other activation path, so the CRM
 * owns them all:
 * - prospect -> active, closed
 * - active   -> paused, closed
 * - paused   -> active, closed
 * - closed   -> active
 * - unknown  -> nothing but itself (fail closed)
 * Nothing moves back to prospect. The current status is always the first option.
 */
export function allowedOrganizationStatusTargets(current: string): string[] {
  switch (current) {
    case 'prospect':
      return ['prospect', 'active', 'closed'];
    case 'active':
      return ['active', 'paused', 'closed'];
    case 'paused':
      return ['paused', 'active', 'closed'];
    case 'closed':
      return ['closed', 'active'];
    default:
      return [current];
  }
}

export const ORGANIZATION_STATUS_LABELS: Record<string, string> = {
  prospect: 'Prospect',
  active: 'Active',
  paused: 'Paused',
  closed: 'Closed',
};

/**
 * THE "is this organization already on this contact" rule: case- and whitespace-
 * insensitive. It stops the exact repeat, not a differently worded duplicate.
 */
export function findOrganizationNameClash<T extends { name: string }>(organizations: readonly T[], name: string): T | undefined {
  const target = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return organizations.find((o) => o.name.trim().replace(/\s+/g, ' ').toLowerCase() === target);
}
