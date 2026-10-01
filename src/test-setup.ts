import '@testing-library/jest-dom';
import { queryClient } from '@/lib/queryClient';

// Tests assert error states directly; a retry backoff would only delay them.
queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } });

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

  // jsdom lacks the pointer-capture and scrolling APIs Radix Select calls while it opens,
  // and the ResizeObserver Radix's popper measures with.
  const proto = window.HTMLElement.prototype as HTMLElement & Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}
