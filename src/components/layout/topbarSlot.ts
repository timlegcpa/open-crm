/**
 * The id of the sticky top bar's slot in the owner shell. AppShell renders an empty element
 * with this id; PageHeader portals a page's title and actions into it. A constant in its own
 * module, so a page that imports PageHeader never pulls in the shell.
 */
export const TOPBAR_SLOT_ID = 'app-topbar-slot';
