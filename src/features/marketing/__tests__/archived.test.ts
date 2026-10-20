import { describe, expect, it } from 'vitest';
import { joinQuotes, type MarketingContactRow, type QuoteRow } from '../api';

const contact = (id: string, archived_at: string | null): MarketingContactRow => ({
  id,
  created_at: '2026-03-01T15:00:00Z',
  submitted_at: null,
  full_name: `Person ${id}`,
  business_name: null,
  status: 'client',
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
});
