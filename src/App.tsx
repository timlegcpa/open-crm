import { Suspense } from 'react';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { lazyNamed } from '@/features/lazy';
import { publicRoutes } from '@/features/registry';
import { PublicApp } from '@/PublicApp';

/**
 * One router, three audiences.
 *
 * - Public routes (the registry's `publicRoutes`: signing, verification, unsubscribe, start
 *   links, invitations, password reset) match first and need no session. Nothing on that
 *   path loads supabase-js or the auth provider: this file, PublicApp and the registry are
 *   the entry bundle, and each public page is its own lazy chunk (bundleBoundary.test.ts
 *   and publicRoutes.test.tsx hold that line).
 * - Every other URL lazy-loads AuthenticatedApp: sign-in, the second factor, then the
 *   database decides who the account is: the owner gets OwnerApp, a client gets PortalApp,
 *   anyone else a no-access screen.
 */

const AuthenticatedApp = lazyNamed(() => import('@/AuthenticatedApp'), 'AuthenticatedApp');

function Loading() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <p className="text-muted-foreground">Loading...</p>
    </main>
  );
}

function AppRoutes() {
  return useRoutes([
    { element: <PublicApp />, children: publicRoutes },
    {
      path: '*',
      element: (
        <Suspense fallback={<Loading />}>
          <AuthenticatedApp />
        </Suspense>
      ),
    },
  ]);
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <Toaster />
    </BrowserRouter>
  );
}
