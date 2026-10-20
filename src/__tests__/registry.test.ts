import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { matchRoutes, type RouteObject } from 'react-router-dom';

// The registry loads with the entry bundle that every public page downloads. If a manifest
// reached any of these statically, importing the registry below would throw.
vi.mock('@/lib/supabase', () => {
  throw new Error('a manifest statically imports @/lib/supabase');
});
vi.mock('@supabase/supabase-js', () => {
  throw new Error('a manifest statically imports @supabase/supabase-js');
});
vi.mock('@/lib/auth', () => {
  throw new Error('a manifest statically imports the auth provider');
});
vi.mock('pdfjs-dist', () => {
  throw new Error('a manifest statically imports pdfjs-dist');
});

import { PUBLIC_PATHS, links } from '@/features/links';
import {
  FEATURES,
  activeWorkspaceTab,
  contactActivityCards,
  contactHeaderActions,
  contactSidePanels,
  contactTabs,
  isBoundedPage,
  isTabOn,
  isWorkspacePage,
  navGroups,
  newMenu,
  ownerNav,
  ownerRouteTree,
  ownerRoutes,
  ownerStandaloneRoutes,
  portalHomeCards,
  portalProfileSections,
  portalRoutes,
  portalTabs,
  publicRoutes,
  settingsSections,
  shellCounts,
  workspaceHandle,
  workspaceRoutes,
  workspaceTabs,
} from '@/features/registry';
import { BOUNDED_PAGE, NAV_SECTIONS, type OwnerNavItem, type WorkspaceRouteHandle } from '@/features/types';

const FEATURES_DIR = path.resolve(__dirname, '..', 'features');
const DOMAINS = ['board', 'crm', 'documents', 'email', 'esign', 'marketing', 'mcp', 'messages', 'ops', 'portal', 'requests', 'settings'];

/** Every route with its full path from the root of its list ('' for an index route). */
function flatten(routes: readonly RouteObject[], parent = ''): Array<{ route: RouteObject; full: string }> {
  return routes.flatMap((route) => {
    const full = route.index ? parent : [parent, route.path ?? ''].filter(Boolean).join('/');
    return [{ route, full }, ...flatten(route.children ?? [], full)];
  });
}

/** A concrete URL a pattern matches: ':id' and '*' become sample segments. */
function sample(pattern: string): string {
  return `/${pattern}`.replace(/:[^/]+/g, 'sample').replace(/\*$/, 'sample-token');
}

const portalTree: RouteObject[] = [{ path: 'portal', children: portalRoutes }];
const opens = (routes: RouteObject[], url: string) => matchRoutes(routes, url.split('?')[0]) !== null;

const ROUTE_LISTS: Record<string, RouteObject[]> = {
  ownerRoutes,
  workspaceRoutes,
  ownerStandaloneRoutes,
  portalRoutes,
  publicRoutes,
};

describe('feature registry', () => {
  it('lists each of the twelve feature folders once, by folder name', () => {
    const folders = readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(FEATURES_DIR, d.name, 'manifest.tsx')))
      .map((d) => d.name)
      .sort();
    expect(folders).toEqual(DOMAINS);
    expect(FEATURES.map((f) => f.id).sort()).toEqual(DOMAINS);
  });

  it('manifests statically import only what the entry bundle can afford', () => {
    const allowed = new Set(['react', 'react-router-dom', 'lucide-react', '@/features/lazy', '@/features/types', '@/features/links']);
    const importFrom = /^\s*import\s+(type\s+)?[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm;
    const bareImport = /^\s*import\s+['"]([^'"]+)['"]/gm;
    for (const id of DOMAINS) {
      const source = readFileSync(path.join(FEATURES_DIR, id, 'manifest.tsx'), 'utf8');
      const found: string[] = [];
      for (const m of source.matchAll(importFrom)) if (!m[1]) found.push(m[2]);
      for (const m of source.matchAll(bareImport)) found.push(m[1]);
      expect(found.filter((spec) => !allowed.has(spec)), `${id}/manifest.tsx`).toEqual([]);
    }
  });

  it('routes are relative and use only element and children', () => {
    for (const [name, routes] of Object.entries(ROUTE_LISTS)) {
      for (const { route, full } of flatten(routes)) {
        expect(route.path?.startsWith('/') ?? false, `${name}: ${route.path}`).toBe(false);
        for (const field of ['lazy', 'loader', 'action', 'errorElement', 'ErrorBoundary'] as const) {
          expect(route[field], `${name}: ${full} sets ${field}, which useRoutes ignores`).toBeUndefined();
        }
      }
    }
  });

  it('every nav item and portal tab opens a registered screen', () => {
    for (const item of ownerNav) {
      expect(item.path.startsWith('/'), item.path).toBe(true);
      expect(opens(ownerRouteTree, item.path), `nav ${item.label} -> ${item.path}`).toBe(true);
    }
    for (const tab of portalTabs) {
      expect(tab.path === '/portal' || tab.path.startsWith('/portal/'), tab.path).toBe(true);
      expect(opens(portalTree, tab.path), `portal tab ${tab.label} -> ${tab.path}`).toBe(true);
    }
  });

  it('paths and keys are unique across features', () => {
    const dupes = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);
    expect(dupes(ownerNav.map((n) => n.path))).toEqual([]);
    expect(dupes(portalTabs.map((t) => t.path))).toEqual([]);
    expect(dupes(contactTabs.map((t) => t.key))).toEqual([]);
    expect(dupes(contactHeaderActions.map((a) => a.key))).toEqual([]);
    expect(dupes(contactSidePanels.map((p) => p.key))).toEqual([]);
    expect(dupes(contactActivityCards.map((c) => c.key))).toEqual([]);
    expect(dupes(settingsSections.map((s) => s.key))).toEqual([]);
    expect(dupes(portalHomeCards.map((c) => c.key))).toEqual([]);
    expect(dupes(portalProfileSections.map((s) => s.key))).toEqual([]);
    expect(dupes(workspaceTabs.map((t) => t.key))).toEqual([]);
    expect(dupes(shellCounts.map((c) => c.key))).toEqual([]);
    expect(dupes(newMenu.map((n) => n.key))).toEqual([]);
    expect(dupes([...flatten(ownerRoutes), ...flatten(workspaceRoutes), ...flatten(ownerStandaloneRoutes)].map((r) => r.full))).toEqual([]);
    expect(dupes(flatten(portalRoutes).map((r) => r.full))).toEqual([]);
    expect(dupes(flatten(publicRoutes).map((r) => r.full))).toEqual([]);
  });

  it('has one owner home, one portal home and at most one portal frame', () => {
    expect(flatten(ownerRoutes).filter((r) => r.route.index)).toHaveLength(1);
    // Without exactly one, /portal would fall to the portal's catch-all redirect and loop.
    expect(flatten(portalRoutes).filter((r) => r.route.index)).toHaveLength(1);
    expect(FEATURES.filter((f) => f.portalLayout).length).toBeLessThanOrEqual(1);
  });

  it('every link in links.ts opens a registered screen for its audience', () => {
    type Audience = 'owner' | 'portal' | 'public';
    const cases: Record<keyof typeof links, Array<{ args: unknown[]; audience: Audience }>> = {
      contacts: [{ args: [], audience: 'owner' }],
      newContact: [{ args: [], audience: 'owner' }],
      contact: [{ args: ['c-1'], audience: 'owner' }],
      contactTab: contactTabs.map((t) => ({ args: ['c-1', t.key], audience: 'owner' as const })),
      board: [{ args: [], audience: 'owner' }],
      boardItem: [{ args: ['b-1'], audience: 'owner' }],
      requests: [{ args: [], audience: 'owner' }],
      newRequest: [{ args: ['c-1'], audience: 'owner' }],
      request: [{ args: ['r-1'], audience: 'owner' }],
      documents: [{ args: [], audience: 'owner' }, { args: ['c-1'], audience: 'owner' }],
      document: [{ args: ['d-1'], audience: 'owner' }],
      messages: [{ args: [], audience: 'owner' }],
      conversation: [{ args: ['c-1'], audience: 'owner' }],
      newMessage: [{ args: ['c-1'], audience: 'owner' }],
      esign: [{ args: [], audience: 'owner' }],
      newEnvelope: [{ args: [], audience: 'owner' }, { args: [{ contactId: 'c-1', documentId: 'd-1' }], audience: 'owner' }],
      envelope: [{ args: ['e-1'], audience: 'owner' }],
      email: [{ args: [], audience: 'owner' }],
      newGroupEmail: [{ args: [['c-1', 'c-2']], audience: 'owner' }],
      marketing: [{ args: [], audience: 'owner' }],
      auditLog: [{ args: [], audience: 'owner' }],
      jobs: [{ args: [], audience: 'owner' }],
      settings: [{ args: [], audience: 'owner' }],
      settingsSection: settingsSections.map((s) => ({ args: [s.key], audience: 'owner' as const })),
      portalHome: [{ args: [], audience: 'portal' }],
      portalDocuments: [{ args: [], audience: 'portal' }],
      portalMessages: [{ args: [], audience: 'portal' }],
      portalRequest: [{ args: ['r-1'], audience: 'portal' }],
      portalSign: [{ args: [], audience: 'portal' }],
      portalProfile: [{ args: [], audience: 'portal' }],
      forgotPassword: [{ args: [], audience: 'public' }],
    };
    expect(Object.keys(cases).sort()).toEqual(Object.keys(links).sort());

    for (const [name, list] of Object.entries(cases)) {
      for (const { args, audience } of list) {
        const url = (links[name as keyof typeof links] as (...a: unknown[]) => string)(...args);
        const tree = audience === 'owner' ? ownerRouteTree : audience === 'portal' ? portalTree : publicRoutes;
        expect(opens(tree, url), `links.${name}(${args.map((a) => JSON.stringify(a)).join(', ')}) = ${url}`).toBe(true);
        if (audience !== 'public') expect(opens(publicRoutes, url), `${url} is shadowed by a public route`).toBe(false);
      }
    }
  });

  it('encodes ids into one path segment', () => {
    expect(links.contact('a/b c')).toBe('/contacts/a%2Fb%20c');
    expect(links.newEnvelope({ contactId: 'c 1' })).toBe('/esign/new?contact=c+1');
    expect(links.newEnvelope()).toBe('/esign/new');
  });

  it('serves every PUBLIC_PATHS entry, and every public route is declared there', () => {
    for (const [name, url] of Object.entries(PUBLIC_PATHS)) {
      expect(opens(publicRoutes, url) || opens(publicRoutes, `${url}/sample-token`), `PUBLIC_PATHS.${name}`).toBe(true);
    }
    const declared = new Set<string>(Object.values(PUBLIC_PATHS));
    for (const { full } of flatten(publicRoutes)) {
      expect(declared.has(`/${full.replace(/\/\*$/, '')}`), `public route ${full} is missing from PUBLIC_PATHS`).toBe(true);
    }
  });

  it('no public route shadows a signed-in screen', () => {
    const signedIn = [
      ...flatten(ownerRoutes).map((r) => r.full),
      ...flatten(workspaceRoutes).map((r) => r.full),
      ...flatten(ownerStandaloneRoutes).map((r) => r.full),
      ...flatten(portalTree).map((r) => r.full),
    ];
    for (const pattern of signedIn) {
      expect(opens(publicRoutes, sample(pattern)), `${sample(pattern)} would render a public page`).toBe(false);
    }
  });

  it('sorts every aggregate by order', () => {
    const sorted = (list: Array<{ order: number }>) => list.every((item, i) => i === 0 || list[i - 1].order <= item.order);
    expect(sorted(ownerNav)).toBe(true);
    expect(sorted(portalTabs)).toBe(true);
    expect(sorted(contactTabs)).toBe(true);
    expect(sorted(contactHeaderActions)).toBe(true);
    expect(sorted(contactSidePanels)).toBe(true);
    expect(sorted(contactActivityCards)).toBe(true);
    expect(sorted(settingsSections)).toBe(true);
    expect(sorted(portalHomeCards)).toBe(true);
    expect(sorted(portalProfileSections)).toBe(true);
    expect(sorted(workspaceTabs)).toBe(true);
    expect(sorted(shellCounts)).toBe(true);
    expect(sorted(newMenu)).toBe(true);
  });

  it('a contact tab key never collides with the record route it sits under', () => {
    // /contacts/:id/<key>: 'overview' is the record itself, so no feature may claim it.
    expect(contactTabs.map((t) => t.key)).not.toContain('overview');
  });

  it('a bounded page is opt-in per route, and nothing else is bounded', () => {
    const routes: RouteObject[] = [
      { path: 'contacts', element: null },
      { path: 'board', element: null, handle: BOUNDED_PAGE },
      { path: 'board/:itemId', element: null },
    ];
    expect(isBoundedPage('/board', routes)).toBe(true);
    expect(isBoundedPage('/board/b-1', routes)).toBe(false);
    expect(isBoundedPage('/contacts', routes)).toBe(false);
    expect(isBoundedPage('/nowhere', routes)).toBe(false);
    // Every registered route that sets a handle uses the typed opt-in.
    for (const { route, full } of flatten(ownerRoutes)) {
      if (route.handle !== undefined) expect(route.handle, full).toEqual(BOUNDED_PAGE);
    }
    // A workspace route may add the workspace's two fields, and only those.
    for (const { route, full } of flatten(workspaceRoutes)) {
      if (route.handle === undefined) continue;
      const { panelFirst, pickParam, ...rest } = route.handle as WorkspaceRouteHandle;
      expect(rest, full).toEqual(BOUNDED_PAGE);
      if (panelFirst !== undefined) expect(typeof panelFirst, full).toBe('function');
      if (pickParam !== undefined) expect(pickParam, full).toMatch(/^[a-z]+$/);
    }
  });

  it('groups the nav: unsectioned items first, then the sections in order, empty ones left out', () => {
    expect(navGroups().map((g) => g.key)).toEqual([null, ...NAV_SECTIONS.map((s) => s.key)]);
    const item = (label: string, section?: OwnerNavItem['section']): OwnerNavItem => ({
      label,
      section,
      icon: ownerNav[0].icon,
      path: `/${label}`,
      order: 1,
    });
    expect(navGroups([item('b', 'system'), item('a')])).toEqual([
      { key: null, label: null, items: [item('a')] },
      { key: 'system', label: 'System', items: [item('b', 'system')] },
    ]);
  });

  it('matches the shell and the workspace as ONE tree, so a literal path beats a workspace pattern', () => {
    expect(isWorkspacePage('/contacts')).toBe(true);
    expect(isWorkspacePage('/contacts/abc')).toBe(true);
    expect(isWorkspacePage('/contacts/abc/requests')).toBe(true);
    // The intake is the shell's own page, not the workspace's 'contacts/:id'.
    expect(isWorkspacePage('/contacts/new')).toBe(false);
    expect(isWorkspacePage('/documents')).toBe(true);
    expect(isWorkspacePage('/documents/abc')).toBe(false);
    expect(isWorkspacePage('/esign/new')).toBe(false);
    expect(isWorkspacePage('/settings')).toBe(false);
    // Every workspace screen is bounded by the workspace; the intake is not bounded at all.
    expect(isBoundedPage('/contacts/new')).toBe(false);
  });

  it('reads the deepest handle: the documents pick and the phone rule', () => {
    expect(workspaceHandle('/documents').pickParam).toBe('contact');
    expect(workspaceHandle('/documents').panelFirst?.(new URLSearchParams())).toBe(true);
    expect(workspaceHandle('/documents').panelFirst?.(new URLSearchParams('contact=c-1'))).toBe(false);
    expect(workspaceHandle('/contacts').panelFirst?.(new URLSearchParams('tab=pipeline'))).toBe(true);
    expect(workspaceHandle('/contacts').panelFirst?.(new URLSearchParams('tab=tiers'))).toBe(false);
    // An open record is the screen: its own handle carries no phone rule.
    expect(workspaceHandle('/contacts/abc').panelFirst).toBeUndefined();
    expect(workspaceHandle('/requests')).toEqual({});
  });

  it('every workspace tab opens a workspace screen, and a tab is on under its path with its query', () => {
    for (const tab of workspaceTabs) {
      expect(tab.path.startsWith('/'), tab.path).toBe(true);
      expect(isWorkspacePage(tab.path.split('?')[0]), `tab ${tab.label} -> ${tab.path}`).toBe(true);
      expect(activeWorkspaceTab(tab.path.split('?')[0], new URLSearchParams(tab.path.split('?')[1] ?? ''))?.key, tab.path).toBe(tab.key);
    }
    const tiers = { path: '/contacts?tab=tiers' };
    expect(isTabOn(tiers, '/contacts', new URLSearchParams('tab=tiers&view=x'))).toBe(true);
    expect(isTabOn(tiers, '/Contacts/', new URLSearchParams('tab=tiers'))).toBe(true);
    expect(isTabOn(tiers, '/contacts', new URLSearchParams('tab=pipeline'))).toBe(false);
    expect(isTabOn(tiers, '/contacts', new URLSearchParams())).toBe(false);
    expect(isTabOn({ path: '/board' }, '/board/b-1', new URLSearchParams())).toBe(true);
    expect(isTabOn({ path: '/board' }, '/boardroom', new URLSearchParams())).toBe(false);
    // An open record, and the documents page, light no tab.
    expect(activeWorkspaceTab('/contacts/abc', new URLSearchParams())).toBeNull();
    expect(activeWorkspaceTab('/documents', new URLSearchParams())).toBeNull();
  });

  it('the rail holds the doors, and the screens that are only workspace tabs left it', () => {
    // Contacts is the workspace's door; Documents and E-sign keep a door because they have
    // screens of their own outside the workspace (the workstation, the composer).
    expect(ownerNav.filter((item) => item.workspace).map((i) => i.path)).toEqual(['/contacts']);
    const tabOnly = ['/board', '/requests', '/messages', '/marketing'];
    expect(tabOnly.every((path) => workspaceTabs.some((t) => t.path === path))).toBe(true);
    expect(ownerNav.filter((item) => tabOnly.includes(item.path)).map((i) => i.path)).toEqual([]);
  });

  it('every bottom-bar figure and New-menu entry leads somewhere real', () => {
    for (const count of shellCounts) {
      expect(opens(ownerRouteTree, count.path), `count ${count.label} -> ${count.path}`).toBe(true);
      expect(['waiting', 'total']).toContain(count.kind);
    }
    for (const item of newMenu) {
      // Exactly one of a create screen and a dialog.
      expect(Number(item.path !== undefined) + Number(item.Dialog !== undefined), item.key).toBe(1);
      if (item.path) expect(opens(ownerRouteTree, item.path), `new ${item.label} -> ${item.path}`).toBe(true);
    }
    expect(newMenu.map((n) => n.label)).toEqual(['Contact', 'Work item', 'Request', 'E-sign envelope']);
  });
});
