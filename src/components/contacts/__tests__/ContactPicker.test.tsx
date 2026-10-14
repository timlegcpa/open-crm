import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { ContactPicker } from '@/components/contacts/ContactPicker';
import { useOrganizationTypes, useServiceTypes } from '@/hooks/usePickLists';

const ADA = '10000000-0000-4000-8000-00000000000a';
const ACME = '10000000-0000-4000-8000-00000000000b';
const GRACE = '10000000-0000-4000-8000-00000000000c';
const ALAN = '10000000-0000-4000-8000-00000000000d';

function row(id: string, first: string, last: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    created_at: '2026-03-01T15:00:00Z',
    submitted_at: null,
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    email: null,
    phone: null,
    business_name: null,
    status: 'new_lead',
    source: 'other',
    ...extra,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contacts = [
    row(ADA, 'Ada', 'Lovelace', { status: 'client', email: 'ada@example.com', business_name: 'Analytical Engines' }),
    // A business-only contact: no first or last name.
    row(ACME, '', '', { business_name: 'Acme LLC', email: 'hello@example.com', status: 'one_time' }),
    row(GRACE, 'Grace', 'Hopper', { phone: '(555) 010-0007' }),
    row(ALAN, 'Aaron', 'Turing', { status: 'lost', email: 'alan@example.org' }),
  ];
});

function renderPicker(props: Partial<Parameters<typeof ContactPicker>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ContactPicker onSelect={onSelect} {...props}>
      <button type="button">Choose a contact</button>
    </ContactPicker>,
    { wrapper },
  );
  return { onSelect };
}

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('ContactPicker', () => {
  it('fetches nothing until it is opened', async () => {
    renderPicker();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.calls('contacts')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    await screen.findByText('Grace Hopper');
    expect(fake.calls('contacts').length).toBeGreaterThan(0);
  });

  it('ungrouped, still lists clients first, then by name', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    await screen.findByText('Grace Hopper');
    // Aaron sorts first by name, but is not a client.
    expect(options()).toEqual([
      'Acme LLChello@example.com',
      'Ada LovelaceAnalytical Engines',
      'Aaron Turingalan@example.org',
      'Grace Hopper',
    ]);
  });

  it('groups clients first and names a business-only contact by its business', async () => {
    renderPicker({ grouped: true });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    await screen.findByText('Acme LLC');
    const clients = screen.getByRole('group', { name: 'Clients' });
    const others = screen.getByRole('group', { name: 'Everyone else' });
    expect(within(clients).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Acme LLChello@example.com',
      'Ada LovelaceAnalytical Engines',
    ]);
    expect(within(others).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Aaron Turingalan@example.org',
      'Grace Hopper',
    ]);
  });

  it('filters with the contacts list search rule, phone digits included', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    await screen.findByText('Grace Hopper');
    fireEvent.change(screen.getByRole('combobox', { name: 'Search contacts' }), { target: { value: '5550100007' } });
    await waitFor(() => expect(options()).toEqual(['Grace Hopper']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search contacts' }), { target: { value: 'nobody' } });
    expect(await screen.findByText('No contacts match.')).toBeInTheDocument();
  });

  it('hands the chosen contact back and closes', async () => {
    const { onSelect } = renderPicker({ selectedId: GRACE });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: ADA, name: 'Ada Lovelace', isClient: true }));
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
  });

  it('marks the current pick for a screen reader', async () => {
    renderPicker({ selectedId: GRACE });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    expect(await screen.findByRole('option', { name: /^Grace Hopper\s*\(chosen\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Ada Lovelace/ }).textContent).not.toContain('chosen');
  });

  it('says so when contacts cannot be loaded', async () => {
    fake.state.errors['contacts:select'] = { message: 'permission denied' };
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load contacts.');
  });
});

describe('pick-list hooks', () => {
  it('useServiceTypes reads service_types with its revenue columns, in order', async () => {
    fake.state.tables.service_types = [
      { key: 'project', label: 'Project', colour: null, sort_order: 30, is_active: true, is_system: false, revenue_family: 'one_time', default_cadence: 'one_time' },
      { key: 'retainer', label: 'Monthly retainer', colour: null, sort_order: 10, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'monthly' },
    ];
    const { result } = renderHook(() => useServiceTypes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => r.key)).toEqual(['retainer', 'project']);
    expect(fake.calls('service_types')[0].columns).toContain('revenue_family');
  });

  it('useOrganizationTypes reads organization_types', async () => {
    fake.state.tables.organization_types = [
      { key: 'llc', label: 'LLC', colour: null, sort_order: 20, is_active: true, is_system: false },
    ];
    const { result } = renderHook(() => useOrganizationTypes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fake.state.tables.organization_types[0]]);
    expect(fake.calls('organization_types')[0].columns).toContain('is_system');
  });
});
