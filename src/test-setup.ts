import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { publicQueryClient, queryClient } from '@/lib/queryClient';

// Every screen is a lazy chunk now, so a suite's first findBy* also waits for the modules to
// load; on a cold CI runner that can pass the 1s default. A ceiling, not a delay: a passing
// wait returns as soon as it holds.
configure({ asyncUtilTimeout: 3000 });

// Tests assert error states directly; a retry backoff would only delay them.
for (const client of [queryClient, publicQueryClient]) {
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } });
}

// jsdom does not implement window.matchMedia, so hooks that read it (useIsMobile, useTheme)
// would throw. A test that needs a phone-width or dark-preference answer redefines it.
// Guarded for node-environment test files, where window is undefined.
if (typeof window !== 'undefined') {
  // Node 25 defines its own global localStorage and sessionStorage (empty objects with no
  // methods unless node runs with --localstorage-file), and they shadow jsdom's. Put jsdom's
  // real Storage back so storage-backed behaviour (theme, folded nav sections) is testable.
  const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (dom && typeof window[name]?.getItem !== 'function') {
      Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    }
  }

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
