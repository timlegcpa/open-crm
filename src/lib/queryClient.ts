import { QueryClient } from '@tanstack/react-query';

/**
 * The one query cache. It outlives the owner screens on purpose: it is cleared when
 * the session stops being the owner's (see Gate in App.tsx), not when a component
 * unmounts, which StrictMode does once on every mount in development.
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
