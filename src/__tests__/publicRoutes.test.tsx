import { Component, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// A public page renders with no session. If it, or anything it imports, reached the
// Supabase client, supabase-js, the auth provider or the signed-in app, the import would
// throw here and the page would fail to load.
vi.mock('@/lib/supabase', () => {
  throw new Error('a public route imported @/lib/supabase');
});
vi.mock('@supabase/supabase-js', () => {
  throw new Error('a public route imported @supabase/supabase-js');
});
vi.mock('@/lib/auth', () => {
  throw new Error('a public route imported the auth provider');
});
vi.mock('@/AuthenticatedApp', () => {
  throw new Error('a public route loaded the signed-in app');
});

import { App } from '@/App';
import { publicRoutes } from '@/features/registry';

/** Records what a failed lazy import throws, so a page that never loads cannot pass as an empty one. */
class Catch extends Component<{ onError: (error: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? <p>render failed</p> : this.props.children;
  }
}

function sampleUrl(pattern: string): string {
  return `/${pattern}`.replace(/:[^/]+/g, 'sample').replace(/\*$/, 'sample-token');
}

beforeAll(() => {
  // Hermetic whatever .env.local says: a page that fetches (branding, its edge function)
  // gets a 404 instead of reaching the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 404 })));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('public routes', () => {
  const patterns = publicRoutes.map((route) => route.path ?? '');

  it('include every public entry point', () => {
    for (const path of ['sign/*', 'esign/verify', 'unsubscribe', 'start/*', 'invite/*', 'forgot-password', 'reset-password']) {
      expect(patterns).toContain(path);
    }
  });

  it.each(patterns)('/%s renders with no session, no supabase-js and no auth provider', async (pattern) => {
    const errors: unknown[] = [];
    window.history.pushState({}, '', sampleUrl(pattern));
    const { container } = render(
      <Catch onError={(error) => errors.push(error)}>
        <App />
      </Catch>,
    );
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
    expect(errors).toEqual([]);
    expect(screen.queryByText('render failed')).toBeNull();
    expect(container.textContent?.trim()).not.toBe('');
  });
});
