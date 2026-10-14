import type { ComponentType, LazyExoticComponent } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RouteObject } from 'react-router-dom';

/**
 * THE contract between a feature and the app. Each feature folder (src/features/<id>/) has
 * one `manifest.tsx` exporting `manifest: FeatureManifest`; `registry.ts` collects them, and
 * the owner app, the shell, the portal and the public router read ONLY the registry. A
 * feature adds a screen by editing its own manifest, never a shared file.
 *
 * Rules every manifest follows (src/__tests__/registry.test.ts checks them):
 * - A manifest statically imports only react, react-router-dom, lucide-react,
 *   '@/features/lazy', '@/features/types' and '@/features/links'. Everything it points at
 *   (pages, tabs, cards, badges, the portal frame) is lazy (`lazyNamed`): the registry
 *   loads with the entry bundle that every public page downloads, so a static import of a
 *   page, or of anything that reaches supabase-js or pdf.js, would ship it to every visitor.
 * - Owner and portal route paths are RELATIVE ('documents/:id', no leading slash). Nav and
 *   tab paths are ABSOLUTE ('/documents'). Every nav path must match a route.
 * - Routes use `element` (and `children`), never `lazy`, `loader` or `action`: the app
 *   renders through useRoutes, where those data-router fields do nothing.
 * - Keys (contact tabs, header actions, side panels, settings sections, home cards) and paths
 *   are unique across features.
 * - An owner route whose page lays out its own scrolling sets `handle: BOUNDED_PAGE`.
 * - A public page module lives under src/features/<id>/public/ (the build names its chunk
 *   `public-*`, and bundleBoundary.test.ts proves it never loads supabase-js).
 */

/** The sidebar's groups, in display order. A nav item with no section sits at the top, without a heading. */
export const NAV_SECTIONS = [
  { key: 'workflow', label: 'Workflow' },
  { key: 'growth', label: 'Growth' },
  { key: 'system', label: 'System' },
] as const;

export type NavSectionKey = (typeof NAV_SECTIONS)[number]['key'];

/** A lazily loaded component (a page, a tab, a card, a badge). */
export type LazyComponent<P = object> = LazyExoticComponent<ComponentType<P>>;

/**
 * A live count beside a nav label or a tab: a LAZY component that runs its own query and
 * returns a <CountBadge> (null at zero). Lazy because manifests load with the entry bundle,
 * and a query hook imported statically would pull supabase-js in with it.
 */
export type BadgeComponent = LazyComponent;

/** What the owner shell and the portal frame receive from the signed-in gate. */
export interface ShellProps {
  /** The organization's display name; null until it loads (or when it is not set). */
  orgName: string | null;
  /** The signed-in account's email. */
  email: string;
  onSignOut: () => void;
}

export interface OwnerNavItem {
  label: string;
  icon: LucideIcon;
  /** Absolute: '/documents'. Highlighted on this path and everything under it, unless `end`. */
  path: string;
  /** Position within its section, lower first; ties sort by label. */
  order: number;
  section?: NavSectionKey;
  /** A live count beside the label (unread, unreviewed, waiting). */
  badge?: BadgeComponent;
  /** Highlight only on the exact path. */
  end?: boolean;
}

export interface PortalTab {
  label: string;
  icon: LucideIcon;
  /** Absolute and under /portal: '/portal/documents'. '/portal' is Home. */
  path: string;
  order: number;
  badge?: BadgeComponent;
  end?: boolean;
}

/** What every contact-record tab receives. It fetches the rest itself. */
export interface ContactTabProps {
  contactId: string;
}

/** A tab on the contact record (/contacts/:id/<key>), contributed by the feature that owns its data. */
export interface ContactTab {
  /** The URL segment; unique across features. */
  key: string;
  label: string;
  order: number;
  Component: LazyComponent<ContactTabProps>;
  /** What is WAITING on this tab for this contact (never a total): a lazy <CountBadge> or null. */
  badge?: LazyComponent<ContactTabProps>;
}

/**
 * A button in the contact record's header (Message, New request, E-sign), contributed by the
 * feature that does the work. It renders its own control (a small outline button, or a
 * popover trigger) with an accessible name, and decides for itself when it is disabled.
 */
export interface ContactHeaderAction {
  /** Unique across features. */
  key: string;
  order: number;
  Component: LazyComponent<ContactTabProps>;
}

/**
 * A panel in the contact record's right bar (portal access, what is waiting on the owner),
 * contributed by the feature that owns its data. It draws its own heading and returns null
 * when it has nothing to show. The bar shows on wide screens only, so a panel must never be
 * the one way to reach something.
 */
export interface ContactSidePanel {
  /** Unique across features. */
  key: string;
  order: number;
  Component: LazyComponent<ContactTabProps>;
}

/** A section of Settings (/settings/<key>), contributed by the feature that owns the setting. */
export interface SettingsSection {
  /** The URL segment; unique across features. */
  key: string;
  label: string;
  order: number;
  Component: LazyComponent;
}

/** A card on the client portal's Home page, contributed by the feature that owns its data. */
export interface PortalHomeCard {
  key: string;
  order: number;
  Component: LazyComponent;
}

export interface FeatureManifest {
  /** The folder name under src/features/. */
  id: string;
  ownerNav?: OwnerNavItem[];
  /** Owner routes inside the shell (sidebar, top bar). Relative paths; `{ index: true }` is '/'. */
  ownerRoutes?: RouteObject[];
  /** Owner-only routes WITHOUT the shell (a connector's consent popup). Relative paths. */
  ownerStandaloneRoutes?: RouteObject[];
  portalTabs?: PortalTab[];
  /** Client routes inside the portal frame, relative to /portal; `{ index: true }` is Home. */
  portalRoutes?: RouteObject[];
  /** The portal's frame (header, tabs, banners) around every portal page; renders <Outlet />. One feature provides it. */
  portalLayout?: LazyComponent<ShellProps>;
  portalHomeCards?: PortalHomeCard[];
  /** Routes that need no session ('sign/*', 'unsubscribe'). Relative paths, lazy pages under ./public/. */
  publicRoutes?: RouteObject[];
  contactTabs?: ContactTab[];
  contactHeaderActions?: ContactHeaderAction[];
  contactSidePanels?: ContactSidePanel[];
  settingsSections?: SettingsSection[];
}

/** What an owner route may carry in `handle`. The shell reads it for the route that matched. */
export interface OwnerRouteHandle {
  /**
   * The page fills the window below the top bar and the page itself does not scroll; the
   * page lays out its own scrolling areas (a board whose lanes scroll). Default: the page
   * scrolls with the document.
   */
  bounded?: boolean;
}

/** `handle` for an owner route whose page manages its own scrolling: `{ path: 'board', element: <BoardPage />, handle: BOUNDED_PAGE }`. */
export const BOUNDED_PAGE: OwnerRouteHandle = { bounded: true };
