import { matchRoutes, type RouteObject } from 'react-router-dom';
import { manifest as board } from '@/features/board/manifest';
import { manifest as crm } from '@/features/crm/manifest';
import { manifest as documents } from '@/features/documents/manifest';
import { manifest as email } from '@/features/email/manifest';
import { manifest as esign } from '@/features/esign/manifest';
import { manifest as marketing } from '@/features/marketing/manifest';
import { manifest as mcp } from '@/features/mcp/manifest';
import { manifest as messages } from '@/features/messages/manifest';
import { manifest as ops } from '@/features/ops/manifest';
import { manifest as portal } from '@/features/portal/manifest';
import { manifest as requests } from '@/features/requests/manifest';
import { manifest as settings } from '@/features/settings/manifest';
import {
  NAV_SECTIONS,
  type ContactActivityCard,
  type ContactHeaderAction,
  type ContactSidePanel,
  type ContactTab,
  type FeatureManifest,
  type LazyComponent,
  type NavSectionKey,
  type NewMenuItem,
  type OwnerNavItem,
  type OwnerRouteHandle,
  type PortalHomeCard,
  type PortalProfileSection,
  type PortalTab,
  type SettingsSection,
  type ShellCount,
  type ShellProps,
  type WorkspaceRouteHandle,
  type WorkspaceTab,
} from '@/features/types';

/**
 * Every feature, and the one place the app learns what exists. FROZEN: a feature changes
 * what it contributes by editing its own manifest.tsx, never this file. The shell, the owner
 * app, the portal and the public router read the lists below and nothing else, so no other
 * file names a feature. Display order comes from each entry's `order`, not from this list.
 */
export const FEATURES: readonly FeatureManifest[] = [
  crm,
  board,
  requests,
  documents,
  messages,
  esign,
  email,
  marketing,
  portal,
  mcp,
  ops,
  settings,
];

function byOrderThenLabel<T extends { order: number; label: string }>(a: T, b: T): number {
  return a.order - b.order || a.label.localeCompare(b.label);
}

function byOrderThenKey<T extends { order: number; key: string }>(a: T, b: T): number {
  return a.order - b.order || a.key.localeCompare(b.key);
}

function collect<T>(pick: (feature: FeatureManifest) => readonly T[] | undefined): T[] {
  return FEATURES.flatMap((feature) => pick(feature) ?? []);
}

/** Rail items, in order (group them with navGroups). */
export const ownerNav: OwnerNavItem[] = collect((f) => f.ownerNav).sort(byOrderThenLabel);
/** Owner routes inside the shell, outside the workspace. */
export const ownerRoutes: RouteObject[] = collect((f) => f.ownerRoutes);
/** Owner routes inside the workspace (the client panel and the tab strip), inside the shell. */
export const workspaceRoutes: RouteObject[] = collect((f) => f.workspaceRoutes);
/**
 * The workspace's layout route: a pathless parent of every workspace screen. OwnerApp gives
 * it the layout's element; the helpers below match against it, so routing and the shell can
 * never disagree about which screen is a workspace one.
 */
export const WORKSPACE_LAYOUT: RouteObject = { children: workspaceRoutes };
/**
 * Every owner route inside the shell, as the router sees them: the shell's own routes and
 * the workspace's under its layout. Matched as ONE tree, so a literal path wins over a
 * pattern across the two lists ('contacts/new' over the workspace's 'contacts/:id').
 */
export const ownerRouteTree: RouteObject[] = [...ownerRoutes, WORKSPACE_LAYOUT];
/** The workspace's tab strip, in order. */
export const workspaceTabs: WorkspaceTab[] = collect((f) => f.workspaceTabs).sort(byOrderThenLabel);
/** The bottom bar's figures, in order (the bar draws `waiting` before `total`). */
export const shellCounts: ShellCount[] = collect((f) => f.shellCounts).sort(byOrderThenLabel);
/** The New menu's entries, in order. */
export const newMenu: NewMenuItem[] = collect((f) => f.newMenu).sort(byOrderThenLabel);
/** Owner routes without the shell. */
export const ownerStandaloneRoutes: RouteObject[] = collect((f) => f.ownerStandaloneRoutes);
/** Portal tabs, in order. */
export const portalTabs: PortalTab[] = collect((f) => f.portalTabs).sort(byOrderThenLabel);
/** Portal routes, relative to /portal. */
export const portalRoutes: RouteObject[] = collect((f) => f.portalRoutes);
/** Cards on the portal's Home page, in order. */
export const portalHomeCards: PortalHomeCard[] = collect((f) => f.portalHomeCards).sort(byOrderThenKey);
/** Sections of the portal's Profile page, in order. */
export const portalProfileSections: PortalProfileSection[] = collect((f) => f.portalProfileSections).sort(byOrderThenKey);
/** Routes that need no session. */
export const publicRoutes: RouteObject[] = collect((f) => f.publicRoutes);
/** Tabs on the contact record, in order. */
export const contactTabs: ContactTab[] = collect((f) => f.contactTabs).sort(byOrderThenLabel);
/** Buttons in the contact record's header, in order. */
export const contactHeaderActions: ContactHeaderAction[] = collect((f) => f.contactHeaderActions).sort(byOrderThenKey);
/** Panels in the contact record's right bar, in order. */
export const contactSidePanels: ContactSidePanel[] = collect((f) => f.contactSidePanels).sort(byOrderThenKey);
/** Cards on the contact record's Activity tab, in order. */
export const contactActivityCards: ContactActivityCard[] = collect((f) => f.contactActivityCards).sort(byOrderThenKey);
/** Settings sections, in order. */
export const settingsSections: SettingsSection[] = collect((f) => f.settingsSections).sort(byOrderThenLabel);
/** The portal's frame, from the one feature that provides it (registry.test.ts allows one); null for none. */
export const portalLayout: LazyComponent<ShellProps> | null = FEATURES.find((f) => f.portalLayout)?.portalLayout ?? null;

export interface NavGroup {
  /** null for the items that sit at the top with no heading. */
  key: NavSectionKey | null;
  label: string | null;
  items: OwnerNavItem[];
}

/** The rail's groups in display order: unsectioned items first, then NAV_SECTIONS; empty groups left out. */
export function navGroups(items: readonly OwnerNavItem[] = ownerNav): NavGroup[] {
  const groups: NavGroup[] = [
    { key: null, label: null, items: items.filter((item) => !item.section) },
    ...NAV_SECTIONS.map(({ key, label }) => ({ key, label, items: items.filter((item) => item.section === key) })),
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** True when the owner route matching `pathname` opts into a bounded page (`handle: BOUNDED_PAGE`). */
export function isBoundedPage(pathname: string, routes: RouteObject[] = ownerRouteTree): boolean {
  return (matchRoutes(routes, pathname) ?? []).some((m) => (m.route.handle as OwnerRouteHandle | undefined)?.bounded === true);
}

/** True when `pathname` is a workspace screen (the client panel and the tab strip around it). */
export function isWorkspacePage(pathname: string, routes: RouteObject[] = ownerRouteTree, layout: RouteObject = WORKSPACE_LAYOUT): boolean {
  return (matchRoutes(routes, pathname) ?? []).some((m) => m.route === layout);
}

/** The handle of the deepest route matching `pathname` that sets one, or an empty one. */
export function workspaceHandle(pathname: string, routes: RouteObject[] = ownerRouteTree): WorkspaceRouteHandle {
  const matches = matchRoutes(routes, pathname) ?? [];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const handle = matches[i].route.handle as WorkspaceRouteHandle | undefined;
    if (handle) return handle;
  }
  return {};
}

function cleanPath(path: string): string {
  return path.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * Whether a workspace tab is on: the URL is at or under the tab's path (matched without
 * regard to case, as the router does, and to a trailing slash) and carries every query
 * parameter the tab's path names, with the same value.
 */
export function isTabOn(tab: Pick<WorkspaceTab, 'path'>, pathname: string, search: URLSearchParams): boolean {
  const [path, query = ''] = tab.path.split('?');
  const want = cleanPath(path);
  const here = cleanPath(pathname);
  if (here !== want && !here.startsWith(`${want}/`)) return false;
  for (const [key, value] of new URLSearchParams(query)) {
    if (search.get(key) !== value) return false;
  }
  return true;
}

/** The strip's tab for a URL, or null when none is on (an open record, the documents page). */
export function activeWorkspaceTab(pathname: string, search: URLSearchParams, tabs: readonly WorkspaceTab[] = workspaceTabs): WorkspaceTab | null {
  return tabs.find((tab) => isTabOn(tab, pathname, search)) ?? null;
}
