import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FolderTree from '../explorer/FolderTree';
import type { ExplorerContact } from '../explorer/types';

const unreviewed = vi.hoisted(() => ({ value: {} as Record<string, { docs: unknown[]; folders: unknown[] }> }));

vi.mock('../api', () => ({
  documentKeys: { unreviewedDetailed: () => ['client-documents', 'unreviewed', 'detailed'] },
  getUnreviewedDetailed: vi.fn(() => Promise.resolve(unreviewed.value)),
}));
vi.mock('@/hooks/usePickLists', () => ({
  useContactStatuses: () => ({ data: [{ key: 'former_client', label: 'Former client', colour: null, sort_order: 1 }] }),
  useByKey: (rows: Array<{ key: string }> | undefined) => new Map((rows ?? []).map((r) => [r.key, r])),
}));

const person = (id: string, name: string, status: string, over: Partial<ExplorerContact> = {}): ExplorerContact => ({
  id, full_name: name, business_name: null, email: `${id}@example.com`, phone: null, status, ...over,
});

function renderTree(clients: ExplorerContact[], onSelectClient = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FolderTree clients={clients} selectedClientId={null} onSelectClient={onSelectClient} />
    </QueryClientProvider>,
  );
  return onSelectClient;
}

beforeEach(() => {
  unreviewed.value = {};
  window.localStorage.clear();
});

describe('FolderTree (the documents contact index)', () => {
  it('groups contacts into clients, leads and others, each A-Z, with a status label only under Others', () => {
    renderTree([
      person('b', 'Grace Hopper', 'client'),
      person('a', 'Ada Lovelace', 'client'),
      person('l', 'Alan Turing', 'new_lead'),
      person('f', 'Acme LLC contact', 'former_client', { business_name: 'Acme LLC' }),
    ]);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items[0]).toContain('Ada Lovelace');
    expect(items[1]).toContain('Grace Hopper');
    expect(items[2]).toContain('Alan Turing');
    expect(items[3]).toContain('Former client');
    expect(items[0]).not.toContain('Client');
    expect(screen.getByRole('button', { name: /Clients/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('search narrows by name, business or email', () => {
    renderTree([person('a', 'Ada Lovelace', 'client'), person('g', 'Grace Hopper', 'client', { business_name: 'Acme LLC' })]);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'acme' } });
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'nobody' } });
    expect(screen.getByText('No contacts match your search.')).toBeInTheDocument();
  });

  it("a row shows that contact's unreviewed count and opens the contact by name", async () => {
    unreviewed.value = { a: { docs: [{}, {}], folders: [{}] } };
    const onSelect = renderTree([person('a', 'Ada Lovelace', 'client')]);
    const row = screen.getByText('Ada Lovelace').closest('button')!;
    expect(await within(row).findByTitle('3 unreviewed items')).toHaveTextContent('3');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('a', 'Ada Lovelace');
  });

  it('a collapsed group stays collapsed for this browser', () => {
    renderTree([person('a', 'Ada Lovelace', 'client')]);
    fireEvent.click(screen.getByRole('button', { name: /Clients/ }));
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    expect(window.localStorage.getItem('open-crm:documents:index-collapsed')).toBe('{"clients":true}');
  });
});
