import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { listOrganizationRoster, listOrganizationsForContact, listServicesForContact, listUpsells } from '../api';

const C = '10000000-0000-4000-8000-00000000000a';
const OTHER = '10000000-0000-4000-8000-00000000000b';

/** More rows than one response may carry, created in reverse id order. */
function many(n: number, extra: Record<string, unknown>) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${String(i).padStart(5, '0')}`,
    contact_id: C,
    created_at: `2026-01-01T00:00:${String(59 - (i % 60)).padStart(2, '0')}Z`,
    ...extra,
  }));
}

beforeEach(() => fake.reset());

describe('per-contact reads are paged past the 1,000-row cap', () => {
  it('quotes, organizations and upsells all come back whole, oldest first with the id as tiebreak', async () => {
    fake.state.tables.contact_services = [...many(1201, { state: 'proposed' }), { id: 'x', contact_id: OTHER, created_at: '2026-01-01T00:00:00Z' }];
    fake.state.tables.organizations = many(1001, { name: 'Org' });
    fake.state.tables.contact_upsells = many(1001, { title: 'Idea' });
    const quotes = await listServicesForContact(C);
    expect(quotes).toHaveLength(1201);
    expect(quotes.every((q) => q.contact_id === C)).toBe(true);
    const keys = quotes.map((q) => `${q.created_at}|${q.id}`);
    expect(keys).toEqual([...keys].sort());
    expect(await listOrganizationsForContact(C)).toHaveLength(1001);
    expect(await listUpsells(C)).toHaveLength(1001);
  });

  it('the organization roster never carries a tax ID', async () => {
    fake.state.tables.organizations = [{ id: 'o1', contact_id: C, name: 'Acme', organization_type: 'llc', status: 'active', tax_id: '12-3456789' }];
    await listOrganizationRoster();
    expect(fake.calls('organizations', 'select')[0].columns).not.toContain('tax_id');
  });
});
