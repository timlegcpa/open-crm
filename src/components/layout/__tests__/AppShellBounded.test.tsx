import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The registry's opt-in, with '/board' as the one bounded page.
vi.mock('@/features/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registry')>();
  return { ...actual, isBoundedPage: (pathname: string) => pathname === '/board' };
});

import { AppShell } from '@/components/layout/AppShell';

function renderShell(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell orgName="Example Org" email="owner@example.com" onSignOut={() => {}} />}>
          <Route path="*" element={<p data-testid="page">page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByRole('main');
}

describe('AppShell bounded page', () => {
  it('a page scrolls with the document by default', () => {
    const main = renderShell('/contacts');
    expect(main).not.toHaveAttribute('data-bounded');
    expect(main.className).not.toContain('h-svh');
    expect(screen.getByTestId('page').parentElement).toBe(main);
  });

  it('a bounded page gets the window below the top bar, and the content area does not scroll', () => {
    const main = renderShell('/board');
    expect(main).toHaveAttribute('data-bounded', 'true');
    expect(main.className).toContain('h-svh');
    expect(main.className).toContain('overflow-hidden');
    const area = screen.getByTestId('page').parentElement!;
    expect(area.className).toContain('min-h-0');
    expect(area.className).toContain('flex-1');
  });
});
