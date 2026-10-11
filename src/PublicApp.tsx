import { Suspense } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';
import { publicQueryClient } from '@/lib/queryClient';

/**
 * The frame around every public route: its own query cache (nothing a session fetched can
 * render here) and a loading line while the page's chunk arrives. No session, no
 * supabase-js, no auth provider. A public page calls edge functions through
 * '@/lib/publicEdge' and draws itself inside <PublicPage>.
 */
export function PublicApp() {
  return (
    <QueryClientProvider client={publicQueryClient}>
      <Suspense
        fallback={
          <main className="flex min-h-svh items-center justify-center p-4">
            <p className="text-muted-foreground">Loading...</p>
          </main>
        }
      >
        <Outlet />
      </Suspense>
    </QueryClientProvider>
  );
}
