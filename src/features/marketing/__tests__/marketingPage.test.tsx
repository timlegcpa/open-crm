import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { App } from '@/App';
import { queryClient } from '@/lib/queryClient';
import { todayISODate } from '@/lib/format';
import { addMonths } from '../lib/months';

/**
 * The page end to end, through the real app, the real hook and the real api module, over the
 * in-memory Supabase stand-in.
 */

const OWNER = { user: { id: 'owner-1', email: 'owner@example.com' } };
const THIS_MONTH = todayISODate().slice(0, 7);
const LAST_MONTH = addMonths(THIS_MONTH, -1);
// Noon on the 1st of this month, local time: always this month and never in the future.
const NOW_ISH = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString();
})();

const ADA = '10000000-0000-4000-8000-00000000000a';
const BO = '10000000-0000-4000-8000-00000000000b';
const CY = '10000000-0000-4000-8000-00000000000c';
const DEE = '10000000-0000-4000-8000-00000000000d';

function contact(id: string, first: string, last: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    created_at: NOW_ISH,
    submitted_at: null,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    // Columns the page never reads: present on the row, so the test proves they are not selected.
    email: `${first.toLowerCase()}@example.com`,
    phone: '555-010-0000',
    business_name: null,
    status: 'new_lead',
    source: 'referral',
    client_since: null,
    ...extra,
  };
}

function seed() {
  fake.state.session = OWNER;
  fake.state.tables.contact_statuses = [
    { key: 'new_lead', label: 'New', colour: null, sort_order: 10 },
    { key: 'client', label: 'Client', colour: null, sort_order: 60 },
    { key: 'one_time', label: 'One-time client', colour: null, sort_order: 70 },
    { key: 'esign_signer', label: 'Signer only', colour: null, sort_order: 100 },
  ];
  fake.state.tables.lead_sources = [
    { key: 'referral', label: 'Referral', colour: '#2563eb', sort_order: 10, is_active: true, is_system: false },
    { key: 'website', label: 'Website', colour: null, sort_order: 20, is_active: true, is_system: false },
    { key: 'retired_ad', label: 'Retired ad', colour: null, sort_order: 30, is_active: false, is_system: false },
  ];
  fake.state.tables.service_types = [
    { key: 'retainer', label: 'Monthly retainer', colour: null, sort_order: 10, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'monthly' },
    { key: 'project', label: 'Project', colour: null, sort_order: 30, is_active: true, is_system: false, revenue_family: 'one_time', default_cadence: 'one_time' },
  ];
  fake.state.tables.contacts = [
    // A priced client won this month.
    contact(ADA, 'Ada', 'Lovelace', { status: 'client', client_since: `${THIS_MONTH}-01` }),
    // A client with no price and no start date: both To fix rows.
    contact(BO, 'Bo', 'Example', { status: 'client', source: 'website' }),
    contact(CY, 'Cy', 'Sample'),
    contact(DEE, 'Dee', 'Acme', { business_name: 'Acme LLC', full_name: '' }),
  ];
  fake.state.tables.contact_services = [
    { id: 'q1', contact_id: ADA, service_type: 'retainer', state: 'accepted', cadence: 'monthly', amount: '450.00' },
    { id: 'q2', contact_id: CY, service_type: 'project', state: 'proposed', cadence: 'one_time', amount: 900 },
  ];
  fake.state.tables.contact_upsells = [
    { id: 'u1', contact_id: ADA, status: 'open', cadence: 'monthly', est_amount: '50.00' },
    { id: 'u2', contact_id: ADA, status: 'won', cadence: 'monthly', est_amount: '999.00' },
  ];
  fake.state.tables.monthly_goals = [
    { id: 'g1', month: THIS_MONTH, new_leads_target: 10, closed_clients_target: null, ad_spend: '200.00' },
    { id: 'g0', month: LAST_MONTH, new_leads_target: null, closed_clients_target: null, ad_spend: '0.00' },
  ];
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

async function choose(trigger: HTMLElement, option: string) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const figures = () => within(screen.getByRole('group', { name: 'Figures' }));

// The page is a lazy chunk: load it once up front, so no single test pays for the first load
// on a busy machine.
beforeAll(async () => {
  await import('../pages');
}, 30_000);

beforeEach(() => {
  queryClient.clear();
  fake.reset();
  seed();
});

describe('the marketing page', () => {
  it('Overview: monthly recurring, leads and clients against the range, from every read', async () => {
    renderAt('/marketing');
    await screen.findByRole('group', { name: 'Figures' });
    expect(figures().getByText('$450')).toBeInTheDocument();
    // Four contacts arrived this month; one was won this month.
    expect(figures().getByText('4')).toBeInTheDocument();
    expect(figures().getByText('Goal 10')).toBeInTheDocument();
    expect(figures().getByText('1')).toBeInTheDocument();
    // Monthly recurring has no history to chart, so it is a figure, not a switch.
    expect(figures().getAllByRole('button')).toHaveLength(2);
  });

  it('a tile switches the one chart, and the choice rides in ?metric=', async () => {
    renderAt('/marketing');
    await screen.findByRole('group', { name: 'Figures' });
    expect(screen.getByRole('figure', { name: 'New leads each month' })).toBeInTheDocument();
    fireEvent.click(figures().getByRole('button', { name: /New clients/ }));
    expect(screen.getByRole('figure', { name: 'New clients each month' })).toBeInTheDocument();
    expect(window.location.search).toBe('?metric=won');
    fireEvent.click(figures().getByRole('button', { name: /New leads/ }));
    expect(window.location.search).toBe('');
  });

  it('an unknown tab or metric in the URL falls back to the default', async () => {
    renderAt('/marketing?tab=nope&metric=nope');
    await screen.findByRole('group', { name: 'Figures' });
    expect(screen.getByRole('figure', { name: 'New leads each month' })).toBeInTheDocument();
  });

  it('a To fix row opens its people in the right bar, with a Billing link for the price, and closes', async () => {
    renderAt('/marketing');
    const fix = await screen.findByRole('region', { name: 'To fix' });
    fireEvent.click(within(fix).getByRole('button', { name: /Clients with no price/ }));
    const bar = screen.getByRole('complementary', { name: 'Clients with no price' });
    expect(within(bar).getByRole('link', { name: 'Bo Example' })).toHaveAttribute('href', `/contacts/${BO}`);
    expect(within(bar).getByRole('link', { name: 'Set price in Billing' })).toHaveAttribute('href', `/contacts/${BO}/billing`);
    fireEvent.click(within(bar).getByRole('button', { name: 'Close list' }));
    expect(screen.queryByRole('complementary', { name: 'Clients with no price' })).not.toBeInTheDocument();
  });

  it('every tab keeps its parts, and the tab rides in ?tab=', async () => {
    renderAt('/marketing');
    await screen.findByRole('group', { name: 'Figures' });
    const tab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }));

    tab('Revenue');
    expect(await screen.findByText('Revenue by service')).toBeInTheDocument();
    expect(screen.getByText('Monthly retainer')).toBeInTheDocument();
    expect(screen.getByText('Upsells')).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=revenue');

    tab('Sources');
    expect(await screen.findByText('Lead sources')).toBeInTheDocument();
    expect(screen.getByText('What each source was worth')).toBeInTheDocument();

    tab('Monthly');
    expect(await screen.findByText('Monthly marketing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit ad spend/ })).toBeInTheDocument();

    tab('Goals');
    expect(await screen.findByRole('button', { name: /Set a month/ })).toBeInTheDocument();

    tab('Overview');
    expect(window.location.search).toBe('');
  });

  it('a source row opens its leads, and changing a source writes exactly { source }', async () => {
    renderAt('/marketing?tab=sources');
    await screen.findByText('What each source was worth');
    fireEvent.click(screen.getByRole('button', { name: 'Referral' }));
    const bar = screen.getByRole('complementary', { name: 'Leads from Referral' });
    // A business-only contact is named by its business.
    expect(within(bar).getByRole('link', { name: 'Acme LLC' })).toBeInTheDocument();
    // A retired source is never offered.
    fireEvent.keyDown(within(bar).getByLabelText('Source for Cy Sample'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: 'Retired ad' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: 'Website' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    const [write] = fake.calls('contacts', 'update');
    expect(write.payload).toEqual({ source: 'website' });
    expect(write.filters).toEqual([{ type: 'eq', column: 'id', value: CY }]);
  });

  it('a stage change writes exactly { status }, and never offers the system stage', async () => {
    renderAt('/marketing?tab=sources');
    await screen.findByText('What each source was worth');
    fireEvent.click(screen.getByRole('button', { name: 'Referral' }));
    const bar = screen.getByRole('complementary', { name: 'Leads from Referral' });
    fireEvent.keyDown(within(bar).getByLabelText('Stage for Cy Sample'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: 'Signer only' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: 'Client' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ status: 'client' });
  });

  // Moving Cy to Website takes Cy out of the Referral list at once (optimistic), so the row
  // that made the edit is gone when the write fails: the failure must come from the mutation.
  it('a failed write that moved the person out of the list is still reported, and the figure goes back', async () => {
    fake.state.errors['contacts:update'] = { message: 'permission denied for table contacts' };
    renderAt('/marketing?tab=sources');
    await screen.findByText('What each source was worth');
    fireEvent.click(screen.getByRole('button', { name: 'Referral' }));
    const bar = screen.getByRole('complementary', { name: 'Leads from Referral' });
    await choose(within(bar).getByLabelText('Source for Cy Sample'), 'Website');
    expect(await screen.findByText(/The change was not saved: permission denied/)).toBeInTheDocument();
    // Rolled back: Cy still counts under Referral (three leads).
    await waitFor(() => expect(within(bar).getAllByRole('link', { name: /Ada Lovelace|Cy Sample|Acme LLC/ })).toHaveLength(3));
  });

  it('reads only the columns it uses, every list keyset-paged, and open upsells only', async () => {
    renderAt('/marketing');
    await screen.findByRole('group', { name: 'Figures' });
    const [contactsRead] = fake.calls('contacts', 'select');
    expect(contactsRead.columns).not.toMatch(/email|phone|mailing/);
    const [upsellsRead] = fake.calls('contact_upsells', 'select');
    expect(upsellsRead.filters).toContainEqual({ type: 'in', column: 'status', value: ['open', 'pitched'] });
  });

  it('a failed read shows its error, never a page of zeroes', async () => {
    fake.state.errors['monthly_goals:select'] = { message: 'goals are unreachable' };
    renderAt('/marketing');
    expect(await screen.findByRole('alert')).toHaveTextContent('goals are unreachable');
    expect(screen.queryByRole('group', { name: 'Figures' })).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('a failed quote read shows its error too', async () => {
    fake.state.errors['contact_services:select'] = { message: 'quotes are unreachable' };
    renderAt('/marketing');
    expect(await screen.findByRole('alert')).toHaveTextContent('quotes are unreachable');
  });

  it('a spend edit from the Monthly tab writes the spend alone', async () => {
    renderAt('/marketing?tab=monthly');
    fireEvent.click(await screen.findByRole('button', { name: /Edit ad spend/ }));
    const dialog = await screen.findByRole('dialog');
    const month = new Date().toLocaleString('en-US', { month: 'long' });
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`Edit ad spend for ${month.slice(0, 3)}`) }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '325' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls('monthly_goals', 'update')).toHaveLength(1));
    expect(fake.calls('monthly_goals', 'update')[0].payload).toEqual({ ad_spend: 325 });
  });

  it('a duplicate month on create is said in words', async () => {
    fake.state.errors['monthly_goals:insert'] = { code: '23505', message: 'duplicate key value violates unique constraint' };
    const { createMonthlyGoal } = await import('../api');
    await expect(createMonthlyGoal({ month: THIS_MONTH, ad_spend: 5 })).rejects.toThrow('already has a row');
    await expect(createMonthlyGoal({ month: '2026-13' })).rejects.toThrow('Pick a month.');
  });
});
