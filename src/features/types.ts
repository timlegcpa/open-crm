import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
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
 * - Keys (contact tabs, header actions, side panels, activity cards, settings sections, home
 *   cards, portal profile sections) and paths are unique across features.
 * - An owner route whose page lays out its own scrolling sets `handle: BOUNDED_PAGE`.
 * - A public page module lives under src/features/<id>/public/ (the build names its chunk
 *   `public-*`, and bundleBoundary.test.ts proves it never loads supabase-js).
 */

/** The rail's groups, in display order (a hairline apart; headed in the phone drawer). A nav item with no section sits at the top. */
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
  /**
   * The item stands for the workspace: it is also highlighted on every workspace screen
   * that no other rail item claims (the board, requests, messages...). One item sets it.
   */
  workspace?: boolean;
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

/**
 * A card on the contact record's Activity tab, below the portal activity feed (the group
 * emails a contact was sent), contributed by the feature that owns its data. It draws its
 * own Panel and returns null when it has nothing to show.
 */
export interface ContactActivityCard {
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

/**
 * A section of the client portal's Profile page (two-factor sign-in), contributed by the
 * feature that owns it. It draws its own Panel and acts on whoever is signed in. The page
 * leaves every section out during View as client: the owner must not change a client's
 * sign-in.
 */
export interface PortalProfileSection {
  /** Unique across features. */
  key: string;
  order: number;
  Component: LazyComponent;
}

/**
 * A tab on the workspace's one strip (the board, the pipeline, requests...), contributed by
 * the feature that owns the screen. The strip sits above every workspace screen, beside the
 * client panel. A tab is a link: it is on while the URL is under `path` and carries every
 * query parameter `path` names ('/contacts?tab=tiers').
 */
export interface WorkspaceTab {
  /** Unique across features. */
  key: string;
  label: string;
  /** Drawn alone on a phone, where the labels do not fit; the label stays its name. */
  icon: LucideIcon;
  /** Absolute, may carry a query: '/requests', '/contacts?tab=tiers'. Must open a workspace route. */
  path: string;
  order: number;
  /** What is WAITING behind the tab (never a total): a lazy <CountBadge> or null. */
  badge?: BadgeComponent;
}

/** What a shell count receives: the number, once known, to draw however the shell draws it. */
export interface ShellCountProps {
  children: (value: number | undefined) => ReactNode;
}

/**
 * A figure in the shell's bottom bar, contributed by the feature that owns it. `waiting` is
 * what is waiting on the owner (unread, to review, to accept); `total` is the size of the
 * book (clients, open leads). Each is a link to where the work is. `Count` is lazy and runs
 * its own query, on the same key as the feature's badge, so the two share one fetch.
 */
export interface ShellCount {
  /** Unique across features. */
  key: string;
  label: string;
  /** Absolute, may carry a query. */
  path: string;
  order: number;
  kind: 'waiting' | 'total';
  Count: LazyComponent<ShellCountProps>;
}

/** What a New-menu dialog receives: it opens where the owner is and closes itself. */
export interface NewMenuDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * An entry in the shell's one New menu (Contact, Work item, Request, E-sign envelope),
 * contributed by the feature that creates the thing. Exactly one of `path` (go to the
 * feature's own create screen) or `Dialog` (open the feature's create dialog on the page
 * the owner is on).
 */
export interface NewMenuItem {
  /** Unique across features. */
  key: string;
  label: string;
  icon: LucideIcon;
  order: number;
  path?: string;
  Dialog?: LazyComponent<NewMenuDialogProps>;
}

export interface FeatureManifest {
  /** The folder name under src/features/. */
  id: string;
  /** The rail. A screen that is a workspace tab is not also a rail item. */
  ownerNav?: OwnerNavItem[];
  /** Owner routes inside the shell (rail, top bar). Relative paths; `{ index: true }` is '/'. */
  ownerRoutes?: RouteObject[];
  /**
   * Owner routes inside the WORKSPACE: the shell, plus the client panel on the left and the
   * tab strip across the top, mounted once while the screen under them changes. Relative
   * paths. The workspace bounds every screen; one without `handle: BOUNDED_PAGE` scrolls in
   * a ScrollArea the workspace provides. `handle` may also carry `panelFirst`/`pickParam`
   * (WorkspaceRouteHandle).
   */
  workspaceRoutes?: RouteObject[];
  workspaceTabs?: WorkspaceTab[];
  shellCounts?: ShellCount[];
  newMenu?: NewMenuItem[];
  /** Owner-only routes WITHOUT the shell (a connector's consent popup). Relative paths. */
  ownerStandaloneRoutes?: RouteObject[];
  portalTabs?: PortalTab[];
  /** Client routes inside the portal frame, relative to /portal; `{ index: true }` is Home. */
  portalRoutes?: RouteObject[];
  /** The portal's frame (header, tabs, banners) around every portal page; renders <Outlet />. One feature provides it. */
  portalLayout?: LazyComponent<ShellProps>;
  portalHomeCards?: PortalHomeCard[];
  portalProfileSections?: PortalProfileSection[];
  /** Routes that need no session ('sign/*', 'unsubscribe'). Relative paths, lazy pages under ./public/. */
  publicRoutes?: RouteObject[];
  contactTabs?: ContactTab[];
  contactHeaderActions?: ContactHeaderAction[];
  contactSidePanels?: ContactSidePanel[];
  contactActivityCards?: ContactActivityCard[];
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

/** What a workspace route may carry in `handle`, read for the deepest route that matched. */
export interface WorkspaceRouteHandle extends OwnerRouteHandle {
  /**
   * Below `lg` there is room for one pane. True when the client panel is that pane: where
   * choosing a contact IS the screen. Default: the screen wins (a `pickParam` screen has its
   * own rule, below).
   */
  panelFirst?: (search: URLSearchParams) => boolean;
  /**
   * A pick in the client panel sets this query parameter on the current screen (documents:
   * `?contact=<id>`), and the panel marks the contact it names. Below `lg` the panel is the
   * screen until the parameter holds a valid id, the same check the page makes before it
   * reads one. Default: a pick opens the contact's record.
   */
  pickParam?: string;
}

/** The id of the client panel's search box: Ctrl K focuses it while it is on screen. */
export const CLIENT_PANEL_SEARCH_ID = 'workspace-client-search';
