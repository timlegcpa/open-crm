import { links } from '@/features/links';

/** A portal account's status, as client_portal_accounts stores it. */
export type PortalAccountStatus = 'invited' | 'active' | 'suspended' | 'deactivated';

export interface PortalAccount {
  id: string;
  user_id: string | null;
  contact_id: string;
  role: string;
  status: PortalAccountStatus;
  invited_email: string | null;
  invited_at: string | null;
  activated_at: string | null;
  last_login_at: string | null;
  login_count: number;
}

/** What the contact's portal access is, read off its accounts; 'none' when it has none. */
export type PortalAccessStatus = PortalAccountStatus | 'none';

/** Best first: one active account means the contact has access, whatever the others say. */
const PRIORITY: readonly PortalAccountStatus[] = ['active', 'invited', 'suspended', 'deactivated'];

export const PORTAL_ACCESS_LABEL: Record<PortalAccessStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
  deactivated: 'Deactivated',
  none: 'No portal',
};

/** The dot beside the label: colour carries status only. */
export const PORTAL_ACCESS_DOT: Record<PortalAccessStatus, string> = {
  active: 'bg-success',
  invited: 'bg-link',
  suspended: 'bg-caution',
  deactivated: 'bg-muted-foreground',
  none: 'bg-muted-foreground',
};

export function bestPortalAccount<T extends Pick<PortalAccount, 'status'>>(accounts: readonly T[]): T | null {
  for (const status of PRIORITY) {
    const found = accounts.find((a) => a.status === status);
    if (found) return found;
  }
  return null;
}

export function bestPortalAccountStatus(accounts: readonly Pick<PortalAccount, 'status'>[]): PortalAccessStatus {
  return bestPortalAccount(accounts)?.status ?? 'none';
}

/**
 * A task's link is rendered as an in-app link only when it stays on this site: one leading
 * slash, never "//" or a backslash (both leave the origin in a browser). The database
 * refuses anything else on write; this guards the render too.
 */
export function isInternalTaskLink(link: unknown): link is string {
  return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') && !link.includes('\\');
}

/** The owner's per-contact switches (contacts.portal_sidebar_config). */
export interface PortalSidebarConfig {
  hide_documents: boolean;
  hide_messages: boolean;
}

export function readSidebarConfig(value: unknown): PortalSidebarConfig {
  const config = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { hide_documents: config.hide_documents === true, hide_messages: config.hide_messages === true };
}

/** The portal paths a hidden section closes, the section's page and everything under it. */
export function hiddenPortalPaths(config: PortalSidebarConfig): string[] {
  const paths: string[] = [];
  if (config.hide_documents) paths.push(links.portalDocuments());
  if (config.hide_messages) paths.push(links.portalMessages());
  return paths;
}

/** True when `pathname` is a hidden path or anything beneath it. */
export function isHiddenPortalPath(pathname: string, hidden: readonly string[]): boolean {
  const path = pathname.replace(/\/+$/, '');
  return hidden.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface GreetingContact {
  first_name: string | null;
  spouse_first_name: string | null;
  spouse_email: string | null;
}

/** The name to greet: the spouse's when the signed-in address is the spouse's. */
export function greetingName(contact: GreetingContact, signedInEmail: string): string | null {
  const email = signedInEmail.trim().toLowerCase();
  const isSpouse = contact.spouse_email !== null && contact.spouse_email.trim().toLowerCase() === email && email !== '';
  const name = (isSpouse ? contact.spouse_first_name : contact.first_name)?.trim();
  return name ? name : null;
}

/** "Good morning", by the viewer's own clock. */
export function timeOfDayGreeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
