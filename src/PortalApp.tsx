import { Suspense } from 'react';
import { Navigate, Outlet, useRoutes } from 'react-router-dom';
import { portalLayout, portalRoutes } from '@/features/registry';
import type { ShellProps } from '@/features/types';

/** Until a feature provides the portal's frame: the page alone. */
function BareFrame() {
  return <Outlet />;
}

/**
 * Everything behind the client gate, rendered only once the database has named the
 * contact this account belongs to (useAuth().clientContactId). The portal lives under
 * /portal; any other address a client opens lands on the portal's Home.
 */
export function PortalApp(props: ShellProps) {
  const Frame = portalLayout;
  const element = useRoutes([
    {
      path: 'portal',
      element: Frame ? <Frame {...props} /> : <BareFrame />,
      children: [...portalRoutes, { path: '*', element: <Navigate to="/portal" replace /> }],
    },
    { path: '*', element: <Navigate to="/portal" replace /> },
  ]);
  return (
    <Suspense
      fallback={
        <main className="flex min-h-svh items-center justify-center p-4">
          <p className="text-muted-foreground">Loading...</p>
        </main>
      }
    >
      {element}
    </Suspense>
  );
}
