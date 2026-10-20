import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

// The registry's opt-in, with '/report' as the one bounded page and no workspace screens.
vi.mock('@/features/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registry')>();
  return { ...actual, isBoundedPage: (pathname: string) => pathname === '/report', isWorkspacePage: () => false };
});

import { AppShell } from '@/components/layout/AppShell';

function renderShell(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell orgName="Example Org" email="owner@example.com" onSignOut={() => {}} />}>
            <Route path="*" element={<p data-testid="page">page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('main');
}

describe('AppShell bounded page', () => {
  it('a page scrolls with the document by default', () => {
    const main = renderShell('/settings');
    expect(main).not.toHaveAttribute('data-bounded');
    expect(main.className.split(' ')).not.toContain('h-svh');
    expect(main.className.split(' ')).toContain('min-h-svh');
    // The content area grows, so a short page still puts the bottom bar at the window's foot.
    const area = screen.getByTestId('page').parentElement!;
    expect(area.parentElement).toBe(main);
    expect(area.className).toContain('flex-1');
    expect(area.className).not.toContain('min-h-0');
  });

  it('a bounded page gets the window below the top bar, and the content area does not scroll', () => {
    const main = renderShell('/report');
    expect(main).toHaveAttribute('data-bounded', 'true');
    expect(main.className.split(' ')).toContain('h-svh');
    expect(main.className).toContain('overflow-hidden');
    const area = screen.getByTestId('page').parentElement!;
    expect(area.className).toContain('min-h-0');
    expect(area.className).toContain('flex-1');
  });
});
