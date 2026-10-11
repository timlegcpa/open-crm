import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';
import { navGroups, ownerNav } from '@/features/registry';
import { THEME_STORAGE_KEY } from '@/hooks/useTheme';
import { storageKey } from '@/lib/storage';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(path = '/contacts', onSignOut = vi.fn()) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell orgName="Example Org" email="owner@example.com" onSignOut={onSignOut} />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, onSignOut };
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main' });
const sectionList = (label: string) => {
  const heading = within(mainNav()).getByRole('button', { name: label });
  return document.getElementById(heading.getAttribute('aria-controls') ?? '') as HTMLElement;
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('AppShell', () => {
  it('draws every registry nav item as a link, under its section heading', () => {
    renderShell();
    const groups = navGroups();
    expect(groups.length).toBeGreaterThan(1);
    expect(within(mainNav()).getAllByRole('link')).toHaveLength(ownerNav.length);
    for (const group of groups) {
      const list = group.label ? sectionList(group.label) : (within(mainNav()).getAllByRole('list')[0] as HTMLElement);
      expect(within(list).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(group.items.map((i) => i.path));
      for (const item of group.items) {
        expect(within(list).getByRole('link', { name: item.label })).toHaveAttribute('href', item.path);
      }
    }
  });

  it('marks the page you are on, including a page under a nav item', () => {
    renderShell('/contacts/10000000-0000-4000-8000-00000000000a');
    expect(within(mainNav()).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    expect(within(mainNav()).getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('folds a section, remembers it, and keeps open a folded section that holds the current page', () => {
    const first = renderShell('/contacts');
    fireEvent.click(within(mainNav()).getByRole('button', { name: 'Growth' }));
    expect(sectionList('Growth')).not.toBeVisible();
    expect(within(mainNav()).getByRole('button', { name: 'Growth' })).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem(storageKey('nav', 'collapsed')) ?? '[]')).toEqual(['growth']);
    first.unmount();

    const second = renderShell('/contacts');
    expect(sectionList('Growth')).not.toBeVisible();
    second.unmount();

    renderShell('/marketing');
    expect(sectionList('Growth')).toBeVisible();
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

  it('shows the organization and the account, and signs out', () => {
    const { onSignOut } = renderShell();
    expect(screen.getByText('Example Org')).toBeInTheDocument();
    expect(screen.getByText('Signed in as owner@example.com.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('hides the top bar on desktop only while its slot is empty', () => {
    renderShell();
    const slot = document.getElementById(TOPBAR_SLOT_ID);
    expect(slot).not.toBeNull();
    expect(slot!.parentElement!.className).toContain(`md:has-[#${TOPBAR_SLOT_ID}:empty]:hidden`);
  });

  it('opens the same nav in a drawer on a phone, and closes it on navigation', async () => {
    renderShell('/contacts');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(drawer).getAllByRole('link', { name: /./ }).length).toBeGreaterThanOrEqual(ownerNav.length);
    fireEvent.click(within(drawer).getByRole('link', { name: 'Board' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/board');
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });

  it('draws a nav badge beside its label, leaving the link named by the label', async () => {
    vi.resetModules();
    vi.doMock('@/features/registry', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/features/registry')>();
      const { lazy } = await import('react');
      const { CountBadge } = await import('@/components/ui/count-badge');
      const Unread = lazy(async () => ({ default: () => <CountBadge value={3} title="Unread messages" /> }));
      const items = actual.ownerNav.map((item) => (item.path === '/messages' ? { ...item, badge: Unread } : item));
      return { ...actual, navGroups: () => actual.navGroups(items) };
    });
    const { AppShell: ShellWithBadge } = await import('@/components/layout/AppShell');
    render(
      <MemoryRouter initialEntries={['/contacts']}>
        <Routes>
          <Route element={<ShellWithBadge orgName={null} email="owner@example.com" onSignOut={() => {}} />}>
            <Route path="*" element={<p>page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('Unread messages: 3')).toHaveTextContent('3');
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('href', '/messages');
    vi.doUnmock('@/features/registry');
  });
});
