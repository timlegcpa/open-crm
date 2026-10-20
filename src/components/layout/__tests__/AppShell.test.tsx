import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The bottom bar's figures run their own queries, against the fake project.
vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

// The floating search reads the contact list; here it only has to show that it opened.
vi.mock('@/features/workspace/QuickSearch', () => ({
  QuickSearch: () => <input aria-label="Find a contact" />,
}));

import { AppShell } from '@/components/layout/AppShell';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';
import { navGroups, ownerNav } from '@/features/registry';
import { CLIENT_PANEL_SEARCH_ID } from '@/features/types';
import { THEME_STORAGE_KEY } from '@/hooks/useTheme';
import { storageKey } from '@/lib/storage';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(path = '/settings', onSignOut = vi.fn()) {
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell orgName="Example Org" email="owner@example.com" onSignOut={onSignOut} />}>
            <Route path="*" element={<Where />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onSignOut };
}

/** The desktop rail's nav (the drawer's mounts only while it is open). */
const railNav = () => screen.getAllByRole('navigation', { name: 'Main' })[0];

async function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
  return screen.findByRole('dialog', { name: 'Menu' });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('AppShell rail', () => {
  it('draws every registry nav item as an icon link named by its label, one run per section', () => {
    renderShell();
    const groups = navGroups();
    expect(groups.length).toBeGreaterThan(1);
    expect(within(railNav()).getAllByRole('link')).toHaveLength(ownerNav.length);
    const lists = within(railNav()).getAllByRole('list');
    expect(lists).toHaveLength(groups.length);
    groups.forEach((group, i) => {
      expect(within(lists[i]).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(group.items.map((item) => item.path));
      for (const item of group.items) {
        expect(within(lists[i]).getByRole('link', { name: item.label })).toHaveAttribute('href', item.path);
      }
    });
  });

  it('marks the page you are on, and lights the workspace door on a workspace screen no item claims', () => {
    const first = renderShell('/contacts/10000000-0000-4000-8000-00000000000a');
    expect(within(railNav()).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    first.unmount();

    // The board is a workspace tab, not a rail item: the door stands for it.
    const second = renderShell('/board');
    expect(within(railNav()).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    second.unmount();

    // Documents is a workspace screen with a door of its own.
    renderShell('/documents');
    expect(within(railNav()).getByRole('link', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
    expect(within(railNav()).getByRole('link', { name: 'Contacts' })).not.toHaveAttribute('aria-current');
  });

  it('switches light and dark from the foot of the rail, labelled by what a click does, and remembers it', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light mode' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('names the organization, and the account menu says who is signed in and signs out', async () => {
    const { onSignOut } = renderShell();
    expect(screen.getByRole('link', { name: 'Example Org' })).toHaveAttribute('href', '/');
    // The account button is named by who is signed in.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Signed in as owner@example.com.' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('owner@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('Ctrl K focuses the client panel search where it shows, and floats a search beside the rail elsewhere', async () => {
    renderShell();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(await screen.findByLabelText('Find a contact')).toBeInTheDocument();
    // Dismissed, it folds away (and its box with it).
    fireEvent.keyDown(screen.getByLabelText('Find a contact'), { key: 'Escape' });
    expect(screen.queryByLabelText('Find a contact')).toBeNull();

    // A panel box on screen wins; jsdom lays nothing out, so say it has a box.
    const box = document.createElement('input');
    box.id = CLIENT_PANEL_SEARCH_ID;
    box.getClientRects = () => [{}] as unknown as DOMRectList;
    document.body.appendChild(box);
    fireEvent.keyDown(document, { key: 'K', metaKey: true });
    expect(document.activeElement).toBe(box);
    expect(screen.queryByLabelText('Find a contact')).toBeNull();
    box.remove();
  });
});

describe('AppShell top bar and content', () => {
  it('hides the top bar on desktop only while its slot is empty', () => {
    renderShell('/settings');
    const slot = document.getElementById(TOPBAR_SLOT_ID);
    expect(slot).not.toBeNull();
    expect(slot!.parentElement!.className).toContain(`md:has-[#${TOPBAR_SLOT_ID}:empty]:hidden`);
    expect(screen.getByRole('main')).not.toHaveAttribute('data-workspace');
  });

  it('on a workspace screen the shell draws no slot (the workspace owns the one) and a bounded page', () => {
    renderShell('/requests');
    expect(document.getElementById(TOPBAR_SLOT_ID)).toBeNull();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('data-workspace', 'true');
    expect(main).toHaveAttribute('data-bounded', 'true');
    // The phone keeps its bar, for the menu button.
    expect(screen.getByRole('button', { name: 'Open menu' }).parentElement!.className).toContain('md:hidden');
  });

  it('pins the bottom bar to the foot of the window, desktop only', () => {
    renderShell('/settings');
    const bar = screen.getByRole('region', { name: 'Status' });
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');
    expect(bar.className).toContain('md:flex');
    expect(bar.parentElement).toBe(screen.getByRole('main'));
  });
});

describe('AppShell drawer (phones)', () => {
  it('opens the labelled nav in a drawer, and closes it on navigation', async () => {
    renderShell('/settings');
    const drawer = await openDrawer();
    expect(within(drawer).getAllByRole('link', { name: /./ }).length).toBeGreaterThanOrEqual(ownerNav.length);
    expect(within(drawer).getByText('Signed in as owner@example.com.')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('link', { name: 'Documents' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/documents');
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('folds a section, remembers it, and keeps open a folded section that holds the current page', async () => {
    const first = renderShell('/settings');
    let drawer = await openDrawer();
    const growth = () => within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('button', { name: 'Growth' });
    const growthList = () => document.getElementById(growth().getAttribute('aria-controls') ?? '') as HTMLElement;
    fireEvent.click(within(drawer).getByRole('button', { name: 'Growth' }));
    expect(growthList()).not.toBeVisible();
    expect(growth()).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem(storageKey('nav', 'collapsed')) ?? '[]')).toEqual(['growth']);
    first.unmount();

    const second = renderShell('/settings');
    drawer = await openDrawer();
    expect(growthList()).not.toBeVisible();
    second.unmount();

    renderShell('/email');
    await openDrawer();
    expect(growthList()).toBeVisible();
  });

  it('signs out from the drawer', async () => {
    const { onSignOut } = renderShell();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('AppShell counts', () => {
  it('draws a nav badge once, on the rail icon, leaving the link named by the label', async () => {
    vi.resetModules();
    vi.doMock('@/features/registry', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/features/registry')>();
      const { lazy } = await import('react');
      const { CountBadge } = await import('@/components/ui/count-badge');
      const Unread = lazy(async () => ({ default: () => <CountBadge value={3} title="Uploads to review" /> }));
      const items = actual.ownerNav.map((item) => (item.path === '/esign' ? { ...item, badge: Unread } : item));
      return { ...actual, ownerNav: items, navGroups: () => actual.navGroups(items) };
    });
    const { AppShell: ShellWithBadge } = await import('@/components/layout/AppShell');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route element={<ShellWithBadge orgName={null} email="owner@example.com" onSignOut={() => {}} />}>
              <Route path="*" element={<p>page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findAllByLabelText('Uploads to review: 3')).toHaveLength(1);
    const link = screen.getByRole('link', { name: 'E-sign' });
    expect(link).toHaveAttribute('href', '/esign');
    expect(link).not.toHaveTextContent('3');
    vi.doUnmock('@/features/registry');
  });
});
