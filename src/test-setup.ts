import '@testing-library/jest-dom';

// jsdom does not implement window.matchMedia — mock it so hooks using
// matchMedia (e.g. useIsMobile in src/hooks/use-mobile.tsx, used by the
// shadcn Sidebar) don't throw when rendered in tests.
// Guard for Node-environment test files (e.g. crypto.test.ts) where window is undefined.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
