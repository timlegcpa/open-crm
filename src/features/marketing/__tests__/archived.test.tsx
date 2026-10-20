import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { joinQuotes, type MarketingContactRow, type QuoteRow } from '../api';
import { useMarketingData } from '../useMarketingData';

const contact = (id: string, archived_at: string | null, status = 'client'): MarketingContactRow => ({
  id,
  created_at: '2026-03-01T15:00:00Z',
  submitted_at: null,
  full_name: `Person ${id}`,
  business_name: null,
  status,
  source: 'other',
  client_since: '2026-03-01',
  archived_at,
});

const quote = (id: string, contact_id: string): QuoteRow => ({
  id,
  contact_id,
  service_type: 'retainer',
  state: 'accepted',
  cadence: 'monthly',
  amount: '500.00',
});

describe('the marketing figures and the archive', () => {
  it('drops an archived contact and its quotes before the metrics read them', () => {
    const page = joinQuotes([contact('a', null), contact('b', '2026-03-05T10:00:00Z')], [quote('q1', 'a'), { ...quote('q2', 'b'), amount: '900.00' }]);
    expect(page.map((c) => c.id)).toEqual(['a']);
    expect(page[0].contact_services.map((q) => q.amount)).toEqual(['500.00']);
  });

  describe('open upsells', () => {
    beforeEach(() => {
      fake.reset();
      fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
      fake.state.tables.contact_services = [];
      fake.state.tables.monthly_goals = [];
      fake.state.tables.lead_sources = [];
      fake.state.tables.contact_statuses = [];
      fake.state.tables.service_types = [];
      fake.state.tables.contact_upsells = [
        { id: 'u1', contact_id: 'a', status: 'open', cadence: 'monthly', est_amount: '500.00' },
      ];
    });

    const proposed = async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => useMarketingData(), { wrapper });
      await waitFor(() => expect(result.current.ready).toBe(true));
      return { mrr: result.current.upsells.proposedMRR, arr: result.current.upsells.proposedARR };
    };

    it('counts a live contact’s upsell', async () => {
      fake.state.tables.contacts = [contact('a', null, 'warm')];
      expect(await proposed()).toEqual({ mrr: 500, arr: 6000 });
    });

    it('leaves out an archived contact’s upsell', async () => {
      fake.state.tables.contacts = [contact('a', '2026-03-05T10:00:00Z', 'warm')];
      expect(await proposed()).toEqual({ mrr: 0, arr: 0 });
    });
  });
});
