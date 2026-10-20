import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake, functionsHttpError } from '@/__tests__/fakeSupabase';
import { App } from '@/App';
import { queryClient } from '@/lib/queryClient';

const OWNER = { user: { id: 'owner-1', email: 'owner@example.com' } };
const ADA = '10000000-0000-4000-8000-00000000000a';
const BO = '10000000-0000-4000-8000-00000000000b';
const CY = '10000000-0000-4000-8000-00000000000c';

function contact(id: string, first: string, last: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    created_at: '2026-03-01T15:00:00Z',
    updated_at: '2026-03-01T15:00:00Z',
    submitted_at: null,
    first_name: first,
    last_name: last,
    full_name: last ? `${first} ${last}` : first,
    email: null,
    phone: null,
    business_name: null,
    status: 'new_lead',
    source: 'other',
    spouse_first_name: null,
    spouse_last_name: null,
    spouse_name: null,
    spouse_email: null,
    spouse_phone: null,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    client_since: null,
    contact_services: [] as unknown[],
    ...extra,
  };
}

function seed() {
  fake.state.session = OWNER;
  fake.state.tables.contact_statuses = [
    { key: 'new_lead', label: 'New', colour: '#2563eb', sort_order: 10 },
    { key: 'hot', label: 'Hot', colour: '#dc2626', sort_order: 30 },
    { key: 'client', label: 'Client', colour: '#16a34a', sort_order: 60 },
    { key: 'one_time', label: 'One-time client', colour: null, sort_order: 70 },
    { key: 'lost', label: 'Lost', colour: null, sort_order: 90 },
    { key: 'esign_signer', label: 'Signer only', colour: null, sort_order: 100 },
  ];
  fake.state.tables.lead_sources = [
    { key: 'other', label: 'Other', colour: null, sort_order: 10, is_active: true },
    { key: 'referral', label: 'Referral', colour: null, sort_order: 20, is_active: true },
    { key: 'retired_ad', label: 'Retired ad', colour: null, sort_order: 30, is_active: false },
  ];
  fake.state.tables.service_types = [
    { key: 'retainer', label: 'Retainer', colour: null, sort_order: 10, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'monthly' },
    { key: 'annual_plan', label: 'Annual plan', colour: null, sort_order: 20, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'annual' },
  ];
  fake.state.tables.contacts = [
    contact(ADA, 'Ada', 'Example', { email: 'ada@example.com', phone: '(555) 010-0001', business_name: 'Example Studio', source: 'referral', spouse_first_name: 'Al' }),
    contact(BO, 'Bo', 'Sample', { email: 'bo@example.org', phone: '555-010-0002', status: 'client', client_since: '2025-01-02' }),
    contact(CY, 'Cy', 'Test', { phone: '555-010-0003', status: 'hot' }),
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

/** The names the index shows, in order. */
function indexNames(): string[] {
  return screen.getAllByRole('checkbox', { name: /^Select / }).map((c) => c.getAttribute('aria-label')!.replace('Select ', ''));
}

function setWide(wide: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: wide && query === '(min-width: 1024px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// The pages are lazy routes: load them once up front, so the first test does not spend
// its find timeout compiling a cold chunk while the rest of the suite runs alongside.
beforeAll(async () => {
  await Promise.all([
    import('@/features/workspace/WorkspaceLayout'),
    import('@/pages/contacts/ContactsList'),
    import('@/pages/contacts/ContactWorkspace'),
    import('@/pages/contacts/ContactIntake'),
  ]);
}, 30_000);

// Under a full parallel run these screens render slowly enough to miss the shared 3 s find
// window now and then. More time, same assertions: each find and each test may wait longer.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  fake.reset();
  seed();
  localStorage.clear();
});

afterEach(() => setWide(false));

describe('contacts index', () => {
  it('puts every contact under its status section, titled from the table, clients as "Last, First"', async () => {
    renderAt('/contacts?tab=all');
    expect(await screen.findByRole('region', { name: 'New' })).toHaveTextContent('Ada Example');
    expect(screen.getByRole('region', { name: 'Hot' })).toHaveTextContent('Cy Test');
    // The clients are one list, whatever their status's own label.
    expect(screen.getByRole('region', { name: 'Clients' })).toHaveTextContent('Sample, Bo');
  });

  it('shows a renamed status label straight from the table', async () => {
    fake.state.tables.contact_statuses[0].label = 'Fresh enquiry';
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    expect(screen.getByRole('region', { name: 'Fresh enquiry' })).toHaveTextContent('Ada Example');
  });

  it('searches name, email, business, phone digits and the spouse', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    const search = screen.getByLabelText('Search contacts');
    fireEvent.change(search, { target: { value: 'bo@example' } });
    expect(indexNames()).toEqual(['Sample, Bo']);
    fireEvent.change(search, { target: { value: 'studio' } });
    expect(indexNames()).toEqual(['Ada Example']);
    fireEvent.change(search, { target: { value: '0100003' } });
    expect(indexNames()).toEqual(['Cy Test']);
    fireEvent.change(search, { target: { value: 'al' } });
    expect(indexNames()).toContain('Ada Example');
    fireEvent.change(search, { target: { value: 'nobody' } });
    expect(screen.getByText('No contacts match.')).toBeInTheDocument();
  });

  it("the panel's Clients switch: every client, one-time clients included, in ONE A-Z list, remembered", async () => {
    fake.state.tables.contacts.push(
      contact('10000000-0000-4000-8000-00000000000d', 'Di', 'Able', { status: 'one_time' }),
      contact('10000000-0000-4000-8000-00000000000e', 'Ed', 'Zed', { status: 'client' }),
    );
    const first = renderAt('/contacts');
    await screen.findByText('Sample, Bo');
    // All is the default: the leads show, by stage.
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    const head = () => screen.getByLabelText('Which contacts').parentElement as HTMLElement;
    expect(head()).toHaveTextContent('5 contacts');
    expect(indexNames()).toContain('Ada Example');
    fireEvent.click(screen.getByRole('radio', { name: 'Clients' }));
    expect(head()).toHaveTextContent('3 clients');
    expect(localStorage.getItem('open-crm:workspace:panelScope')).toBe('"clients"');
    first.unmount();
    renderAt('/contacts');
    await screen.findByText('Sample, Bo');
    expect(screen.getByRole('radio', { name: 'Clients' })).toHaveAttribute('aria-checked', 'true');
    expect(indexNames()).toEqual(['Able, Di', 'Sample, Bo', 'Zed, Ed']);
    expect(screen.getByRole('region', { name: 'Clients' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'One-time client' })).toBeNull();
    // A search reaches everyone, and the clients stay one list.
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'e' } });
    expect(screen.getByRole('region', { name: 'Clients' })).toHaveTextContent('Able, Di');
    expect(screen.queryByRole('region', { name: 'One-time client' })).toBeNull();
    expect(indexNames()).toContain('Ada Example');
  });

  it('the workspace tabs are links, remembered, and leaving the contacts screen clears the selection', async () => {
    // Wide, so the panel (and its selection) stays mounted across screens.
    setWide(true);
    renderAt('/contacts?tab=pipeline');
    await screen.findByRole('checkbox', { name: 'Select Ada Example' });
    const strip = screen.getByRole('tablist', { name: 'Workspace' });
    expect(within(strip).getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    expect(screen.getByRole('region', { name: 'Selected contacts' })).toHaveTextContent('1 selected');
    fireEvent.mouseDown(within(strip).getByRole('tab', { name: 'Table' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=table'));
    expect(localStorage.getItem('open-crm:contacts:tab')).toBe('"table"');
    // A tab of the same screen keeps the selection; another screen clears it.
    expect(screen.getByRole('region', { name: 'Selected contacts' })).toHaveTextContent('1 selected');
    fireEvent.mouseDown(within(strip).getByRole('tab', { name: /^Requests/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/requests'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected contacts' })).toBeNull());
    expect(screen.getByRole('checkbox', { name: 'Select Ada Example' })).not.toBeChecked();
  });

  it('a bare /contacts opens the remembered tab; a stale or misshapen one falls back to Pipeline', async () => {
    localStorage.setItem('open-crm:contacts:tab', '"tiers"');
    const first = renderAt('/contacts');
    await waitFor(() => expect(window.location.search).toBe('?tab=tiers'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Tiers' })).toHaveAttribute('aria-selected', 'true'));
    first.unmount();
    localStorage.setItem('open-crm:contacts:tab', 'null');
    localStorage.setItem('open-crm:contacts:collapsed', '3');
    const second = renderAt('/contacts');
    await screen.findByText('Sample, Bo');
    await waitFor(() => expect(window.location.search).toBe('?tab=pipeline'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Pipeline' })).toHaveAttribute('aria-selected', 'true'));
    second.unmount();
    // The old list tabs are the panel's switch now; their links land on the pipeline.
    renderAt('/contacts?tab=all&view=leads_hot');
    await waitFor(() => expect(window.location.search).toBe('?tab=pipeline&view=leads_hot'));
  });

  it('Tiers ranks active clients only, in their tier rows, and holds that during a search', async () => {
    fake.state.tables.contacts.push(
      contact('10000000-0000-4000-8000-00000000000d', 'Di', 'Able', { status: 'one_time', tier: 'S' }),
      contact('10000000-0000-4000-8000-00000000000e', 'Ed', 'Zed', { status: 'client', tier: 'S' }),
    );
    renderAt('/contacts?tab=tiers');
    const s = await screen.findByRole('region', { name: 'S tier' });
    expect(within(s).getByRole('button', { name: 'Open Zed, Ed' })).toBeInTheDocument();
    // A one-time client keeps a stored tier but is not ranked here.
    expect(within(s).queryByRole('button', { name: /Able, Di/ })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Not ranked' })).getByRole('button', { name: 'Open Sample, Bo' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: /tier$|^Not ranked$/ })).toHaveLength(7);
    // A search narrows the rows and never reaches past the active clients.
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'a' } });
    expect(within(screen.getByRole('region', { name: 'Not ranked' })).getByRole('button', { name: 'Open Sample, Bo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Ada Example/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Zed, Ed/ })).toBeNull();
  });

  // Below lg the Tiers tab hides the index, yet the search and the board filter still narrow
  // the tier rows: the controls that clear them must not be hidden with it.
  it('on a narrow Tiers tab the search and the filter clear sit atop the rows, never in the hidden index', async () => {
    renderAt('/contacts?tab=tiers&view=unpriced');
    await screen.findByRole('region', { name: 'Not ranked' });
    const hidden = (el: HTMLElement) => el.closest('[class~="max-lg:hidden"]') !== null;
    expect(hidden(screen.getByLabelText('Search contacts'))).toBe(false);
    expect(hidden(screen.getByRole('button', { name: 'Clear list filter' }))).toBe(false);
  });

  it('on a wide Tiers tab the search stays atop the client panel, and narrows the rows from there', async () => {
    setWide(true);
    renderAt('/contacts?tab=tiers');
    await screen.findByRole('region', { name: 'Not ranked' });
    expect(screen.getAllByLabelText('Search contacts')).toHaveLength(1);
    const panel = screen.getByLabelText('Search contacts').closest('[class~="w-[240px]"]') as HTMLElement;
    expect(within(panel).getByRole('checkbox', { name: 'Select Sample, Bo' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'nobody' } });
    expect(within(screen.getByRole('region', { name: 'Not ranked' })).queryByRole('button', { name: 'Open Sample, Bo' })).toBeNull();
  });

  it('archived contacts are off every list, and the Archived dialog restores them with the status untouched', async () => {
    fake.state.tables.contacts[2].archived_at = '2026-03-05T10:00:00Z';
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    expect(indexNames()).toEqual(['Ada Example', 'Sample, Bo']);
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'Cy' } });
    expect(screen.getByText('No contacts match.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archived people' });
    expect(within(dialog).getByText(/Restores to Hot/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Cy Test' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ archived_at: null });
    expect(fake.calls('contacts', 'update')[0].filters[0].value).toEqual([CY]);
  });

  it('a row archives its contact with archived_at alone, never the status, and offers Undo', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('button', { name: 'Archive Ada Example' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    const write = fake.calls('contacts', 'update')[0];
    expect(Object.keys(write.payload as object)).toEqual(['archived_at']);
    expect(write.filters[0].value).toEqual([ADA]);
    expect(await screen.findByText('Ada Example archived. The record is kept.')).toBeInTheDocument();
    expect(screen.getByText('Archiving does not revoke portal access; turn that off on the record.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('a bulk archive the server partly refuses keeps the failures selected', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Cy Test' }));
    fake.state.errors['contacts:update'] = { message: 'permission denied' };
    fireEvent.click(within(screen.getByRole('region', { name: 'Selected contacts' })).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/0 of 2 contacts archived/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Ada Example' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Cy Test' })).toBeChecked();
  });

  it('bulk status writes every selected row with the status alone (the database stamps client_since)', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Cy Test' }));
    await choose(screen.getByLabelText('New status'), 'Client');
    fireEvent.click(screen.getByRole('button', { name: 'Apply status' }));
    expect(await screen.findByText('Status changed on 2 of 2 contacts.')).toBeInTheDocument();
    const updates = fake.calls('contacts', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ status: 'client' });
    expect(new Set(updates[0].filters[0].value as string[])).toEqual(new Set([ADA, CY]));
  });

  it('"Email them" opens a group email to exactly the selected contacts', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Cy Test' }));
    const link = within(screen.getByRole('region', { name: 'Selected contacts' })).getByRole('link', { name: 'Email them' });
    expect(link).toHaveAttribute('href', `/email/new?to=${encodeURIComponent(`${ADA},${CY}`)}`);
  });

  it('a bulk status the server refuses says so and keeps the contacts selected', async () => {
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Cy Test' }));
    fake.state.errors['contacts:update'] = { message: 'permission denied' };
    await choose(screen.getByLabelText('New status'), 'Client');
    fireEvent.click(screen.getByRole('button', { name: 'Apply status' }));
    expect(await screen.findByText(/Status changed on 0 of 2 contacts/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Ada Example' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Cy Test' })).toBeChecked();
  });

  it('on a narrow screen the Table tab is the list alone: the table lives on wide screens', async () => {
    renderAt('/contacts?tab=table');
    await screen.findByText('Ada Example');
    expect(screen.queryByText(/contacts in view/)).toBeNull();
  });

  it('bulk delete calls the edge function per contact and reports a partial failure honestly', async () => {
    fake.state.invokeResults[BO] = { data: null, error: functionsHttpError(409, { error: 'delete_in_progress' }) };
    renderAt('/contacts?tab=all');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Sample, Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete contacts' }));
    expect(await screen.findByText('Deleted 1 of 2 contacts.')).toBeInTheDocument();
    expect(screen.getByText(/Bo Sample: This contact is already being deleted/)).toBeInTheDocument();
    expect(fake.state.invokeCalls.map((c) => c.name)).toEqual(['delete-contact', 'delete-contact']);
    expect(fake.calls('contacts', 'delete')).toEqual([]);
  });

  it("shows a Supabase error's own message, not a placeholder", async () => {
    fake.state.errors['contacts:select'] = { message: 'permission denied for table contacts', code: '42501' };
    renderAt('/contacts');
    expect(await screen.findByText('permission denied for table contacts')).toBeInTheDocument();
    expect(screen.getByText('Could not load contacts.')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    fake.state.tables.contacts = [];
    renderAt('/contacts');
    expect(await screen.findByText('No contacts yet.')).toBeInTheDocument();
  });

  it('runs no contact query for a signed-in account that is not the owner', async () => {
    fake.state.isOwner = { data: false, error: null };
    renderAt('/contacts');
    expect(await screen.findByText('This account is not the owner of this CRM.')).toBeInTheDocument();
    expect(fake.state.calls.filter((c) => c.table !== 'audit_logs')).toEqual([]);
  });

  it('clears every cached query on sign-out', async () => {
    renderAt('/contacts');
    await screen.findByText('Sample, Bo');
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Signed in as/ }), { key: 'Enter' });
    const signOut = await screen.findByRole('menuitem', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(signOut);
    });
    await screen.findByLabelText('Email');
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('redirects / to the contacts page', async () => {
    renderAt('/');
    expect(await screen.findByText('Sample, Bo')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/contacts');
  });

  it('shows not-found for an unknown route', async () => {
    renderAt('/nowhere');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});

describe('board and table (wide screens)', () => {
  beforeEach(() => setWide(true));

  it('shows one column per open stage, and the card bar moves a stage with the status alone', async () => {
    renderAt('/contacts');
    const hot = await screen.findByRole('region', { name: 'Hot column' });
    fireEvent.click(within(hot).getByRole('button', { name: 'Show Cy Test' }));
    const bar = await screen.findByRole('complementary', { name: 'Cy Test details' });
    await choose(within(bar).getByLabelText('Stage'), 'Client');
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ status: 'client' });
  });

  async function openCyQuote() {
    const cyQuote = { ...QUOTE, contact_id: CY };
    fake.state.tables.contact_services = [{ ...cyQuote }];
    fake.state.tables.contacts[2].contact_services = [{ ...cyQuote }];
    renderAt('/contacts');
    const hot = await screen.findByRole('region', { name: 'Hot column' });
    fireEvent.click(within(hot).getByRole('button', { name: 'Show Cy Test' }));
    const bar = await screen.findByRole('complementary', { name: 'Cy Test details' });
    // The bar opens before its Services editor: that is a lazy chunk behind a Suspense
    // fallback, so the first test to open a bar in a run sees "Loading services..." first.
    // Wait for the editor itself, never assert on it straight after the bar appears.
    await within(bar).findByRole('button', { name: 'Edit Retainer quote' });
    return bar;
  }

  it('the card bar counts accepted quotes as MRR/ARR and shows proposed work apart', async () => {
    const bar = await openCyQuote();
    expect(within(bar).getByText('$6,000 a year proposed')).toBeInTheDocument();
    expect(within(bar).queryByText('$500')).toBeNull();
  });

  it('a failed price save can be retried with the same value', async () => {
    const bar = await openCyQuote();
    fake.state.errors['contact_services:update'] = { message: 'refused' };
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit Retainer quote' }));
    fireEvent.change(within(bar).getByLabelText('Price'), { target: { value: '600' } });
    fireEvent.keyDown(within(bar).getByLabelText('Price'), { key: 'Enter' });
    await waitFor(() => expect(fake.calls('contact_services', 'update')).toHaveLength(1));
    await act(async () => {});
    delete fake.state.errors['contact_services:update'];
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit Retainer quote' }));
    const price = await within(bar).findByLabelText('Price');
    await waitFor(() => expect(price).not.toBeDisabled());
    fireEvent.change(price, { target: { value: '600' } });
    fireEvent.keyDown(price, { key: 'Enter' });
    await waitFor(() => expect(fake.calls('contact_services', 'update')).toHaveLength(2));
    expect(fake.calls('contact_services', 'update')[1].payload).toEqual({ amount: 600 });
  });

  it('a price typo never saves: "oops0" leaves a $500 price alone', async () => {
    const bar = await openCyQuote();
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit Retainer quote' }));
    fireEvent.change(within(bar).getByLabelText('Price'), { target: { value: 'oops0' } });
    fireEvent.keyDown(within(bar).getByLabelText('Price'), { key: 'Enter' });
    await act(async () => {});
    expect(fake.calls('contact_services', 'update')).toEqual([]);
  });

  it('the price is held while a stage move for the contact is saving', async () => {
    const bar = await openCyQuote();
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit Retainer quote' }));
    let release = () => {};
    fake.state.holds['contacts:update'] = new Promise<void>((r) => {
      release = r;
    });
    await choose(within(bar).getByLabelText('Stage'), 'Client');
    await waitFor(() => expect(within(bar).getByLabelText('Price')).toBeDisabled());
    await act(async () => {
      release();
    });
  });

  it('flags a lead nobody can reach', async () => {
    fake.state.tables.contacts.push(contact('10000000-0000-4000-8000-00000000000d', 'Di', 'Nowhere'));
    renderAt('/contacts');
    const column = await screen.findByRole('region', { name: 'New column' });
    expect(within(column).getByRole('button', { name: 'Show Di Nowhere' })).toHaveTextContent('No email or phone');
    expect(within(column).getByRole('button', { name: 'Show Ada Example' })).not.toHaveTextContent('No email or phone');
  });

  it('a column heading filters the index with ?view=, and an unknown view filters nothing', async () => {
    renderAt('/contacts?tab=pipeline&view=nonsense');
    const hot = await screen.findByRole('region', { name: 'Hot column' });
    expect(indexNames()).toHaveLength(3);
    fireEvent.click(within(hot).getAllByRole('button', { pressed: false })[0]);
    await waitFor(() => expect(indexNames()).toEqual(['Cy Test']));
    expect(window.location.search).toBe('?tab=pipeline&view=leads_hot');
    // The record link keeps the filter, so the panel keeps its rows beside the record.
    expect(screen.getByRole('link', { name: 'Cy Test' })).toHaveAttribute('href', `/contacts/${CY}?view=leads_hot`);
  });

  it('the Table tab counts what is in view and is remembered', async () => {
    renderAt('/contacts');
    await screen.findByRole('region', { name: 'Hot column' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Table' }));
    expect(await screen.findByText('3 of 3 contacts in view')).toBeInTheDocument();
    expect(localStorage.getItem('open-crm:contacts:tab')).toBe('"table"');
  });

  it('a card archives its person off the board, and the board never shows an archived one', async () => {
    fake.state.tables.contacts.push(contact('10000000-0000-4000-8000-00000000000d', 'Di', 'Gone', { status: 'hot', archived_at: '2026-03-05T10:00:00Z' }));
    renderAt('/contacts');
    const hot = await screen.findByRole('region', { name: 'Hot column' });
    expect(within(hot).queryByRole('button', { name: 'Show Di Gone' })).toBeNull();
    fireEvent.click(within(hot).getByRole('button', { name: 'Archive Cy Test' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(Object.keys(fake.calls('contacts', 'update')[0].payload as object)).toEqual(['archived_at']);
  });
});

describe('intake', () => {
  it('requires a first name and refuses a malformed email, writing nothing', async () => {
    renderAt('/contacts/new');
    fireEvent.click(await screen.findByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Enter a first name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Di' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fake.calls('contacts', 'insert')).toEqual([]);
  });

  it('has no form element, so Enter in a field never submits', async () => {
    renderAt('/contacts/new');
    const first = await screen.findByLabelText('First name');
    expect(first.closest('form')).toBeNull();
    fireEvent.change(first, { target: { value: 'Di' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    await act(async () => {});
    expect(fake.calls('contacts', 'insert')).toEqual([]);
  });

  it('saves the contact, its first note and an audit row, then opens the record', async () => {
    renderAt('/contacts/new');
    await screen.findByRole('button', { name: 'Save contact' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: 'Other' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'Retired ad' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Signer only' })).toBeNull();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Di' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Demo' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'di@example.com' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Referral' }));
    fireEvent.change(screen.getByLabelText('First note (optional)'), { target: { value: 'Met at the open day.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));

    expect(await screen.findByRole('heading', { name: 'Di Demo' })).toBeInTheDocument();
    expect(fake.calls('contacts', 'insert')[0].payload).toEqual({
      first_name: 'Di',
      last_name: 'Demo',
      email: 'di@example.com',
      phone: null,
      business_name: null,
      status: 'new_lead',
      source: 'referral',
      submitted_at: null,
    });
    expect(fake.calls('contact_notes', 'insert')[0].payload).toMatchObject({ body: 'Met at the open day.', kind: 'note', source: 'owner' });
    expect(fake.calls('contact_services', 'insert')).toEqual([]);
    await waitFor(() =>
      expect(fake.calls('audit_logs', 'insert').map((c) => (c.payload as { action: string }).action)).toContain('contact_create'),
    );
  });

  it('a client gets accepted quotes and no browser-made client_since; a blank service writes nothing', async () => {
    renderAt('/contacts/new');
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ed' } });
    fireEvent.click(await screen.findByRole('radio', { name: 'Client' }));
    fireEvent.change(await screen.findByLabelText('Retainer'), { target: { value: '$1,200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByRole('heading', { name: 'Ed' })).toBeInTheDocument();
    expect(fake.calls('contacts', 'insert')[0].payload).toMatchObject({ status: 'client' });
    expect(fake.calls('contacts', 'insert')[0].payload).not.toHaveProperty('client_since');
    expect(fake.calls('contact_services', 'insert')[0].payload).toEqual([
      { contact_id: expect.any(String), organization_id: null, service_type: 'retainer', state: 'accepted', cadence: 'monthly', amount: 1200 },
    ]);
  });

  it('still opens the record when the quotes fail after the contact saved, and says so', async () => {
    fake.state.errors['contact_services:insert'] = { message: 'quote refused' };
    renderAt('/contacts/new');
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Fay' } });
    fireEvent.change(await screen.findByLabelText('Annual plan'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Contact saved; its quotes were not.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Fay' })).toBeInTheDocument();
  });

  it('refuses a service amount that is not a number, before writing anything', async () => {
    renderAt('/contacts/new');
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Gus' } });
    fireEvent.change(await screen.findByLabelText('Retainer'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Enter each service amount as a number, or leave it blank.')).toBeInTheDocument();
    expect(fake.calls('contacts', 'insert')).toEqual([]);
  });

  it('shows the database error when the insert is refused', async () => {
    fake.state.errors['contacts:insert'] = { message: 'new row violates row-level security policy for table "contacts"' };
    renderAt('/contacts/new');
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Hal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('violates row-level security policy');
  });
});

/** Opens an in-place field by its display button, types, and presses Enter. */
async function editField(label: string, value: string) {
  // The Overview's field: the right bar's quick edit repeats some of them after it.
  fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(`^${label}:`) }))[0]);
  const input = await screen.findByRole(label === 'Phone' ? 'textbox' : 'textbox', { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('record overview', () => {
  it('saves one field in place on Enter, and only that field', async () => {
    renderAt(`/contacts/${ADA}`);
    expect(await screen.findByRole('heading', { name: 'Ada Example' })).toBeInTheDocument();
    await editField('City', 'Springfield');
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ mailing_city: 'Springfield' });
  });

  it('stores a cleared field as null', async () => {
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    await editField('Phone', '');
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ phone: null });
  });

  it('Escape discards an edit', async () => {
    renderAt(`/contacts/${ADA}`);
    fireEvent.click(await screen.findByRole('button', { name: /^City:/ }));
    const input = await screen.findByRole('textbox', { name: 'City' });
    fireEvent.change(input, { target: { value: 'Nowhere' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => {});
    expect(fake.calls('contacts', 'update')).toEqual([]);
  });

  it("shows the database's message when a save is refused", async () => {
    fake.state.errors['contacts:update'] = { message: 'permission denied for table contacts', code: '42501' };
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    await editField('City', 'Springfield');
    expect(await screen.findByText('permission denied for table contacts')).toBeInTheDocument();
  });

  it('adds a note as the owner, and keeps a note typed while the previous one was saving', async () => {
    let release!: () => void;
    fake.state.holds['contact_notes:insert'] = new Promise<void>((r) => {
      release = r;
    });
    renderAt(`/contacts/${ADA}`);
    const box = await screen.findByLabelText('New note');
    fireEvent.change(box, { target: { value: 'First.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(box, { target: { value: 'Second, still typing' } });
    await act(async () => {
      release();
    });
    expect(await screen.findByText('First.')).toBeInTheDocument();
    expect(box).toHaveValue('Second, still typing');
    expect(fake.calls('contact_notes', 'insert')[0].payload).toEqual({ contact_id: ADA, body: 'First.', kind: 'note', source: 'owner' });
  });

  it('labels a note an agent wrote', async () => {
    fake.state.tables.contact_notes = [
      { id: 'n1', contact_id: ADA, body: 'Logged by the agent.', kind: 'note', source: 'mcp', created_at: '2026-03-02T10:00:00Z' },
    ];
    renderAt(`/contacts/${ADA}`);
    expect(await screen.findByText('Logged by the agent.')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
  });

  it('adds a spouse address and makes it the default through the RPC', async () => {
    renderAt(`/contacts/${ADA}`);
    const form = await screen.findByRole('form', { name: 'Add spouse emails' });
    fireEvent.change(within(form).getByLabelText('New address'), { target: { value: 'al@example.com' } });
    expect(within(form).getByRole('checkbox')).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('al@example.com')).toBeInTheDocument();
    expect(fake.calls('contact_emails', 'insert')[0].payload).toEqual({
      contact_id: ADA,
      kind: 'spouse',
      email: 'al@example.com',
      label: 'other',
      is_default: false,
    });
    expect(fake.state.rpcCalls.filter((r) => r.name === 'contact_emails_set_default')).toEqual([
      { name: 'contact_emails_set_default', args: { p_id: expect.any(String), p_contact_id: ADA, p_kind: 'spouse' } },
    ]);
  });

  it('says so when an address is added but cannot be made the default', async () => {
    fake.state.rpcErrors.contact_emails_set_default = { message: 'MFA session expired' };
    renderAt(`/contacts/${ADA}`);
    const form = await screen.findByRole('form', { name: 'Add spouse emails' });
    fireEvent.change(within(form).getByLabelText('New address'), { target: { value: 'al@example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('The address was added but not made the default: MFA session expired')).toBeInTheDocument();
  });

  it('copies the email by clicking the value, and nothing launches a mail client or dialer', async () => {
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    expect(screen.getAllByRole('button', { name: 'Copy email: ada@example.com' }).length).toBeGreaterThan(0);
    expect(document.querySelector('a[href^="mailto:"], a[href^="tel:"]')).toBeNull();
  });

  it('shows not-found for a missing contact', async () => {
    renderAt('/contacts/10000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Contact not found')).toBeInTheDocument();
  });

  it('never writes with an id that is not a uuid', async () => {
    renderAt('/contacts/not-a-uuid');
    expect(await screen.findByText('Contact not found')).toBeInTheDocument();
    expect(fake.state.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });

  it('archives from the More menu with archived_at alone, and stays on the record', async () => {
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive contact' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(Object.keys(fake.calls('contacts', 'update')[0].payload as object)).toEqual(['archived_at']);
    expect(window.location.pathname).toBe(`/contacts/${ADA}`);
  });

  it('an archived record opens by link, says so, and Restore clears the archive alone', async () => {
    fake.state.tables.contacts[0].archived_at = '2026-03-05T10:00:00Z';
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    expect(screen.getByText('Archived')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ archived_at: null });
  });

  it('the header carries the tier mark; the index rows never do', async () => {
    fake.state.tables.contacts[1].tier = 'A';
    setWide(true);
    renderAt(`/contacts/${BO}`);
    await screen.findByRole('heading', { name: 'Bo Sample' });
    expect(screen.getByRole('img', { name: 'A tier' })).toBeInTheDocument();
    expect(within(await screen.findByRole('region', { name: 'Clients' })).queryByRole('img', { name: /tier/ })).toBeNull();
  });

  it('deletes through the edge function from the More menu and returns to the list', async () => {
    renderAt(`/contacts/${ADA}`);
    await screen.findByRole('heading', { name: 'Ada Example' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete contact' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete contact' }));
    await waitFor(() => expect(window.location.pathname).toBe('/contacts'));
    expect(fake.state.invokeCalls).toEqual([{ name: 'delete-contact', body: { contact_id: ADA } }]);
    expect(fake.calls('contacts', 'delete')).toEqual([]);
  });
});

const QUOTE = {
  id: 'q1',
  contact_id: ADA,
  organization_id: null,
  service_type: 'retainer',
  state: 'proposed',
  cadence: 'monthly',
  amount: '500.00',
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
};

describe('billing', () => {
  it('adds a proposed quote at the service default cadence, unpriced, and changes nothing about the contact', async () => {
    renderAt(`/contacts/${ADA}/billing`);
    const personal = await screen.findByRole('region', { name: 'Quotes for Personal' });
    fireEvent.keyDown(within(personal).getByRole('button', { name: 'Add service' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Annual plan' }));
    await waitFor(() => expect(fake.calls('contact_services', 'insert')).toHaveLength(1));
    expect(fake.calls('contact_services', 'insert')[0].payload).toEqual({
      contact_id: ADA,
      organization_id: null,
      service_type: 'annual_plan',
      state: 'proposed',
      cadence: 'annual',
      amount: null,
    });
    await waitFor(() => expect(fake.calls('contact_services', 'select').length).toBeGreaterThan(0));
    expect(fake.calls('contacts', 'update')).toEqual([]);
  });

  it('accepting a recurring quote makes a lead a client, derived from the quotes re-read on the server', async () => {
    fake.state.tables.contact_services = [{ ...QUOTE }];
    fake.state.tables.contacts[0].contact_services = [{ ...QUOTE }];
    renderAt(`/contacts/${ADA}/billing`);
    const state = await screen.findByRole('radiogroup', { name: 'Retainer state' });
    fireEvent.click(within(state).getByRole('radio', { name: 'Accepted' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contact_services', 'update')[0].payload).toEqual({ state: 'accepted' });
    const [update] = fake.calls('contacts', 'update');
    expect(update.payload).toEqual({ status: 'client' });
    // Compare-and-set on the status just read from the server.
    expect(update.filters).toEqual([
      { type: 'eq', column: 'id', value: ADA },
      { type: 'eq', column: 'status', value: 'new_lead' },
    ]);
  });

  it('a quote derives the status from a fresh read, never the cache: a contact moved to Cold meanwhile stays Cold', async () => {
    fake.state.tables.contact_services = [{ ...QUOTE }];
    fake.state.tables.contacts[0].contact_services = [{ ...QUOTE }];
    renderAt(`/contacts/${ADA}/billing`);
    const state = await screen.findByRole('radiogroup', { name: 'Retainer state' });
    // Another tab moved the contact to Cold; this screen's cache still says New.
    fake.state.tables.contacts[0].status = 'cold';
    fireEvent.click(within(state).getByRole('radio', { name: 'Accepted' }));
    await waitFor(() => expect(fake.calls('contacts', 'select').some((c) => c.columns === 'status')).toBe(true));
    await act(async () => {});
    expect(fake.calls('contacts', 'update')).toEqual([]);
    expect(fake.state.tables.contacts[0].status).toBe('cold');
  });

  it('never promotes a cold contact from a quote', async () => {
    fake.state.tables.contacts[0].status = 'cold';
    fake.state.tables.contact_services = [{ ...QUOTE }];
    fake.state.tables.contacts[0].contact_services = [{ ...QUOTE }];
    renderAt(`/contacts/${ADA}/billing`);
    const state = await screen.findByRole('radiogroup', { name: 'Retainer state' });
    fireEvent.click(within(state).getByRole('radio', { name: 'Accepted' }));
    await waitFor(() => expect(fake.calls('contact_services', 'select').length).toBeGreaterThan(0));
    await act(async () => {});
    expect(fake.calls('contacts', 'update')).toEqual([]);
  });

  it('a rename sends the name alone, even when a refetch moved the status while the editor was open', async () => {
    fake.state.tables.organizations = [
      { id: 'o1', contact_id: ADA, name: 'Acme LLC', organization_type: 'other', tax_id: null, status: 'prospect', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
    ];
    renderAt(`/contacts/${ADA}/billing`);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Acme LLC' }));
    const name = await screen.findByLabelText('Name');
    // Someone else activates the organization; the screen refetches mid-edit.
    fake.state.tables.organizations[0].status = 'active';
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    fireEvent.change(name, { target: { value: 'Acme Studio LLC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls('organizations', 'update')).toHaveLength(1));
    expect(fake.calls('organizations', 'update')[0].payload).toEqual({ name: 'Acme Studio LLC' });
    expect(fake.state.tables.organizations[0].status).toBe('active');
  });

  it('refuses a second organization with the same name, read fresh', async () => {
    fake.state.tables.organizations = [
      { id: 'o1', contact_id: ADA, name: 'Acme LLC', organization_type: 'other', tax_id: null, status: 'prospect', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
    ];
    renderAt(`/contacts/${ADA}/billing`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add organization' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '  acme   llc ' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/Acme LLC is already on this contact/)).toBeInTheDocument();
    expect(fake.calls('organizations', 'insert')).toEqual([]);
  });

  it('writes a won upsell with no estimate to pricing unpriced, never at 0', async () => {
    fake.state.tables.contact_upsells = [
      { id: 'u1', contact_id: ADA, title: 'Quarterly review', service_type: 'retainer', est_amount: null, cadence: 'monthly', status: 'won', notes: null, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
    ];
    renderAt(`/contacts/${ADA}/billing`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to pricing' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to pricing' }));
    await waitFor(() => expect(fake.calls('contact_services', 'insert')).toHaveLength(1));
    expect(fake.calls('contact_services', 'insert')[0].payload).toMatchObject({ service_type: 'retainer', state: 'accepted', amount: null });
  });
});
