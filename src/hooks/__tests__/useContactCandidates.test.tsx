import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { useContactCandidates } from '../useContactCandidates';

const row = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at: '2026-03-01T15:00:00Z',
  submitted_at: null,
  first_name: first,
  last_name: last,
  full_name: `${first} ${last}`,
  email: `${first.toLowerCase()}@example.com`,
  phone: null,
  business_name: null,
  status: 'client',
  source: 'other',
  archived_at: null,
  contact_services: [],
  ...extra,
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contacts = [
    row('10000000-0000-4000-8000-00000000000a', 'Ada', 'Lovelace'),
    row('10000000-0000-4000-8000-00000000000b', 'Grace', 'Hopper', { archived_at: '2026-03-05T10:00:00Z' }),
  ];
});

describe('useContactCandidates', () => {
  it('never offers an archived contact, with or without a search', async () => {
    const all = renderHook(() => useContactCandidates('', true), { wrapper });
    await waitFor(() => expect(all.result.current.contacts.isSuccess).toBe(true));
    expect(all.result.current.candidates.map((c) => c.name)).toEqual(['Ada Lovelace']);
    const searched = renderHook(() => useContactCandidates('grace', true), { wrapper });
    await waitFor(() => expect(searched.result.current.contacts.isSuccess).toBe(true));
    expect(searched.result.current.candidates).toEqual([]);
  });
});
