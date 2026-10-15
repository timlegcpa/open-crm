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
  type OwnerNavItem,
  type OwnerRouteHandle,
  type PortalHomeCard,
  type PortalProfileSection,
  type PortalTab,
  type SettingsSection,
  type ShellProps,
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

/** Sidebar items, in order (group them with navGroups). */
export const ownerNav: OwnerNavItem[] = collect((f) => f.ownerNav).sort(byOrderThenLabel);
/** Owner routes inside the shell. */
export const ownerRoutes: RouteObject[] = collect((f) => f.ownerRoutes);
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

/** The sidebar's groups in display order: unsectioned items first, then NAV_SECTIONS; empty groups left out. */
export function navGroups(items: readonly OwnerNavItem[] = ownerNav): NavGroup[] {
  const groups: NavGroup[] = [
    { key: null, label: null, items: items.filter((item) => !item.section) },
    ...NAV_SECTIONS.map(({ key, label }) => ({ key, label, items: items.filter((item) => item.section === key) })),
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** True when the owner route matching `pathname` opts into a bounded page (`handle: BOUNDED_PAGE`). */
export function isBoundedPage(pathname: string, routes: RouteObject[] = ownerRoutes): boolean {
  return (matchRoutes(routes, pathname) ?? []).some((m) => (m.route.handle as OwnerRouteHandle | undefined)?.bounded === true);
}
