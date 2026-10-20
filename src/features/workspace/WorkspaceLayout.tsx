import { Suspense, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';
import { PageTabsList, PageTabsTrigger } from '@/components/ui/page-tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs } from '@/components/ui/tabs';
import { useWide } from '@/features/crm/useWide';
import { activeWorkspaceTab, isBoundedPage, workspaceHandle, workspaceTabs } from '@/features/registry';
import { cn } from '@/lib/utils';
import { ClientPanel } from './ClientPanel';
import { WorkspaceSearchContext } from './search';

/** The client panel's width: narrower than a side bar, a long name truncates. */
export const CLIENT_PANEL_W = 'w-[240px]';

/**
 * The workspace: the contacts, the board, documents, requests, messages, e-sign and
 * marketing as ONE screen. A layout route, so the client panel on the left and the tab
 * strip across the top mount once and stay while the screen under them changes. The
 * screens are the registry's `workspaceRoutes`, the tabs its `workspaceTabs`.
 *
 * The strip is the top row (the shell draws no top bar here on desktop), it never scrolls
 * (a phone shows each tab as its icon instead), and a page's own title and actions sit in
 * the row under it: THE top-bar slot lives here on a workspace screen, one id, one element.
 *
 * Below `lg` there is room for one pane: the client panel where choosing a contact IS the
 * screen (the route's `panelFirst`), else the screen. The screen stays MOUNTED either way,
 * only hidden, so its own effects (a tab redirect) still run on a phone.
 */
export function WorkspaceLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const wide = useWide();
  const [query, setQuery] = useState('');
  const search = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const handle = workspaceHandle(location.pathname);
  const active = activeWorkspaceTab(location.pathname, search);
  const panelFirst = !wide && (handle.panelFirst?.(search) ?? false);
  const bounded = isBoundedPage(location.pathname);
  const searchValue = useMemo(() => ({ query, setQuery }), [query]);

  const panel = <ClientPanel pickParam={handle.pickParam} />;

  return (
    <WorkspaceSearchContext.Provider value={searchValue}>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {wide && <div className={cn('h-full min-h-0 shrink-0 border-r border-border', CLIENT_PANEL_W)}>{panel}</div>}
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <Tabs
            value={active?.key ?? ''}
            activationMode="manual"
            onValueChange={(key) => {
              const tab = workspaceTabs.find((t) => t.key === key);
              if (tab) navigate(tab.path);
            }}
            className="shrink-0"
          >
            <PageTabsList aria-label="Workspace" className="h-12 overflow-hidden px-1.5 md:px-3">
              {workspaceTabs.map(({ key, label, icon: Icon, badge: Badge }) => (
                <PageTabsTrigger key={key} value={key} className="h-12 gap-1.5 px-2.5 sm:px-3">
                  <Icon className="sm:hidden" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{label}</span>
                  {Badge && (
                    <Suspense fallback={null}>
                      <Badge />
                    </Suspense>
                  )}
                </PageTabsTrigger>
              ))}
            </PageTabsList>
          </Tabs>
          {/* Under the tabs: the page's own title and actions (PageHeader portals here).
              The row hides while no page has filled it. */}
          <div id={TOPBAR_SLOT_ID} className="flex min-h-11 min-w-0 shrink-0 items-center overflow-hidden border-b border-border px-3 empty:hidden md:px-5" />
          {panelFirst && <div className="min-h-0 flex-1">{panel}</div>}
          <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', panelFirst && 'hidden')}>
            {/* Its own boundary: a screen's lazy chunk suspends here, inside the layout,
                rather than at the shell's, which would unmount the panel while it loads. */}
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>
              {bounded ? (
                <Outlet />
              ) : (
                <ScrollArea className="min-h-0 flex-1" fitWidth>
                  <Outlet />
                </ScrollArea>
              )}
            </Suspense>
          </div>
        </div>
      </div>
    </WorkspaceSearchContext.Provider>
  );
}
