import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { queryKeys } from '@/api/queryKeys';
import { BottomBar } from '@/components/layout/BottomBar';
import { lazyNamed } from '@/features/lazy';
import type { ShellCount } from '@/features/types';

const ClientsCount = lazyNamed(() => import('../bookCounts'), 'ClientsCount');
const OpenLeadsCount = lazyNamed(() => import('../bookCounts'), 'OpenLeadsCount');
const COUNTS: ShellCount[] = [
  { key: 'clients', label: 'Clients', path: '/contacts', order: 10, kind: 'total', Count: ClientsCount },
  { key: 'open-leads', label: 'Open leads', path: '/contacts?tab=pipeline', order: 20, kind: 'total', Count: OpenLeadsCount },
];

const row = (id: string, status: string, archived_at: string | null = null) => ({ id, status, archived_at, first_name: id, last_name: '' });

function renderBar(client: QueryClient) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BottomBar counts={COUNTS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contacts = [
    row('a', 'client'),
    row('b', 'one_time'),
    row('c', 'client', '2026-03-05T10:00:00Z'),
    row('d', 'new_lead'),
    row('e', 'hot'),
    row('f', 'hot', '2026-03-05T10:00:00Z'),
    row('g', 'cold'),
    row('h', 'lost'),
  ];
});

describe('the bottom bar book figures', () => {
  it('count working clients and open leads with head-only counts, never the contact list', async () => {
    renderBar(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    // Client and one-time, archived left out; the open stages, Cold and archived left out.
    expect(await screen.findByRole('link', { name: /^Clients\s*2$/ })).toHaveAttribute('href', '/contacts');
    expect(await screen.findByRole('link', { name: /^Open leads\s*2$/ })).toBeInTheDocument();

    const reads = fake.state.calls.filter((c) => c.table === 'contacts');
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.op).toBe('select');
      // A count reads one column and no rows: never the list's column set.
      expect(read.columns).toBe('id');
      expect(read.filters).toContainEqual({ type: 'is', column: 'archived_at', value: null });
    }
  });

  it('refresh when a contact write invalidates the contacts prefix', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderBar(client);
    await screen.findByRole('link', { name: /^Clients\s*2$/ });
    fake.state.tables.contacts.push(row('i', 'client'));
    await client.invalidateQueries({ queryKey: queryKeys.contacts.all });
    await waitFor(() => expect(screen.getByRole('link', { name: /^Clients\s*3$/ })).toBeInTheDocument());
  });
});
