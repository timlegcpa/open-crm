import { Suspense } from 'react';
import { Link, Outlet, useRoutes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { PAGE, PageHeader } from '@/components/layout/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import { lazyNamed } from '@/features/lazy';
import { links } from '@/features/links';
import { WORKSPACE_LAYOUT, ownerRoutes, ownerStandaloneRoutes } from '@/features/registry';
import type { ShellProps } from '@/features/types';

// The workspace reads the contact list for its client panel: its own chunk.
const WorkspaceLayout = lazyNamed(() => import('@/features/workspace/WorkspaceLayout'), 'WorkspaceLayout');

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className={PAGE}>
        <p className="text-muted-foreground">There is nothing at this address.</p>
        <Link to={links.contacts()} className="mt-2 inline-block text-sm text-link underline-offset-4 hover:underline">
          Go to contacts
        </Link>
      </div>
    </>
  );
}

/** A standalone owner page (no shell) still needs somewhere to wait for its chunk. */
function StandaloneFrame() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-svh items-center justify-center p-4">
          <p className="text-muted-foreground">Loading...</p>
        </main>
      }
    >
      <Outlet />
    </Suspense>
  );
}

/**
 * Everything behind the owner gate, rendered only once the database has said "owner". Its
 * routes are the registry's: the shell's pages, the workspace's screens inside the shell
 * (the client panel and the tab strip around them), plus the few owner pages that run
 * without the shell (a connector's consent popup).
 */
export function OwnerApp(props: ShellProps) {
  const element = useRoutes([
    { element: <StandaloneFrame />, children: ownerStandaloneRoutes },
    {
      element: <AppShell {...props} />,
      children: [...ownerRoutes, { ...WORKSPACE_LAYOUT, element: <WorkspaceLayout /> }, { path: '*', element: <NotFound /> }],
    },
  ]);
  return <TooltipProvider delayDuration={300}>{element}</TooltipProvider>;
}
