import { lazy } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactActivityCard, ContactTabProps } from '@/features/types';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

// Two registered cards, as other features' manifests would contribute them.
const { asLazy } = vi.hoisted(() => ({
  asLazy: (render: (props: ContactTabProps) => JSX.Element) => lazy(async () => ({ default: render })),
}));
vi.mock('@/features/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registry')>();
  const contactActivityCards: ContactActivityCard[] = [
    { key: 'first', order: 10, Component: asLazy(({ contactId }) => <p>First card for {contactId}</p>) },
    { key: 'second', order: 20, Component: asLazy(() => <p>Second card</p>) },
  ];
  return { ...actual, contactActivityCards };
});

import { fake } from '@/__tests__/fakeSupabase';
import { ActivityTab } from '../components/ActivityTab';

const ADA = '10000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  fake.reset();
});

describe('the Activity tab', () => {
  it('shows the portal activity, then every registered card in registry order', async () => {
    fake.state.tables.client_activity_log = [
      { id: 'a1', contact_id: ADA, action: 'login', details: {}, created_at: '2026-10-01T15:00:00Z' },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ActivityTab contactId={ADA} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    const first = await screen.findByText(`First card for ${ADA}`);
    const second = await screen.findByText('Second card');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Signed in').compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
