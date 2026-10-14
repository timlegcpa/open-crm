import { QueryClient } from '@tanstack/react-query';

/**
 * The signed-in cache (owner or client). It outlives the screens on purpose: it is cleared
 * whenever the signed-in principal changes (see Gate in AuthenticatedApp.tsx), not when a
 * component unmounts, which StrictMode does once on every mount in development.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

/**
 * The cache for public pages (signer, unsubscribe, invitations, start links). Separate from
 * the signed-in one, so nothing a session fetched can render on a page that has none.
 */
export const publicQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
