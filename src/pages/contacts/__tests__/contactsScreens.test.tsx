import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
    full_name: `${first} ${last}`,
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
    date_of_birth: null,
    spouse_date_of_birth: null,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    client_since: null,
    ...extra,
  };
}

function seed() {
  fake.state.session = OWNER;
  fake.state.tables.contact_statuses = [
    { key: 'new_lead', label: 'New lead', colour: '#2563eb', sort_order: 10 },
    { key: 'client', label: 'Client', colour: null, sort_order: 50 },
  ];
  fake.state.tables.lead_sources = [
    { key: 'other', label: 'Other', colour: null, sort_order: 10, is_active: true },
    { key: 'referral', label: 'Referral', colour: null, sort_order: 20, is_active: true },
    { key: 'retired_ad', label: 'Retired ad', colour: null, sort_order: 30, is_active: false },
  ];
  fake.state.tables.contacts = [
    contact(ADA, 'Ada', 'Example', { email: 'ada@example.com', phone: '(555) 010-0001', business_name: 'Example Studio', source: 'referral' }),
    contact(BO, 'Bo', 'Sample', { email: 'bo@example.org', phone: '555-010-0002', status: 'client' }),
    contact(CY, 'Cy', 'Test', { phone: '555-010-0003' }),
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

function rowNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).queryAllByRole('link')[0]?.textContent ?? '')
    .filter(Boolean);
}

beforeEach(() => {
  fake.reset();
  seed();
});

describe('contacts list', () => {
  it('renders every contact with its status and source labels from the pick-lists', async () => {
    renderAt('/contacts');
    expect(await screen.findByText('Ada Example')).toBeInTheDocument();
    expect(screen.getByText('Bo Sample')).toBeInTheDocument();
    expect(screen.getByText('Cy Test')).toBeInTheDocument();
    const ada = screen.getByText('Ada Example').closest('tr')!;
    expect(within(ada).getByText('New lead')).toBeInTheDocument();
    expect(within(ada).getByText('Referral')).toBeInTheDocument();
    expect(within(ada).getByText('Example Studio')).toBeInTheDocument();
  });

  it('shows a renamed status label straight from the table', async () => {
    fake.state.tables.contact_statuses[0].label = 'Fresh enquiry';
    fake.state.tables.lead_sources[1].label = 'Word of mouth';
    renderAt('/contacts');
    const ada = (await screen.findByText('Ada Example')).closest('tr')!;
    expect(within(ada).getByText('Fresh enquiry')).toBeInTheDocument();
    expect(within(ada).getByText('Word of mouth')).toBeInTheDocument();
    expect(screen.queryByText('New lead')).toBeNull();
  });

  it('searches name, email, business and phone digits', async () => {
    renderAt('/contacts');
    await screen.findByText('Ada Example');
    const search = screen.getByLabelText('Search contacts');
    fireEvent.change(search, { target: { value: 'bo@example' } });
    expect(rowNames()).toEqual(['Bo Sample']);
    fireEvent.change(search, { target: { value: 'studio' } });
    expect(rowNames()).toEqual(['Ada Example']);
    fireEvent.change(search, { target: { value: '0100003' } });
    expect(rowNames()).toEqual(['Cy Test']);
    fireEvent.change(search, { target: { value: 'nobody' } });
    expect(screen.getByText('No contacts match.')).toBeInTheDocument();
  });

  it('filters by a status from the table', async () => {
    renderAt('/contacts');
    await screen.findByText('Ada Example');
    await choose(screen.getByLabelText('Filter by status'), 'Client');
    await waitFor(() => expect(rowNames()).toEqual(['Bo Sample']));
  });

  it('sorts by name', async () => {
    renderAt('/contacts');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['Ada Example', 'Bo Sample', 'Cy Test']);
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['Cy Test', 'Bo Sample', 'Ada Example']);
  });

  it('bulk status change writes only status for the selected contacts', async () => {
    renderAt('/contacts');
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

  it('bulk delete calls the edge function per contact and reports a partial failure honestly', async () => {
    fake.state.invokeResults[BO] = { data: null, error: functionsHttpError(409, { error: 'delete_in_progress' }) };
    renderAt('/contacts');
    await screen.findByText('Ada Example');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ada Example' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bo Sample' }));
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
    await screen.findByText('Ada Example');
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await screen.findByLabelText('Email');
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('redirects / to the list and shows a not-found view for unknown routes', async () => {
    renderAt('/');
    expect(await screen.findByText('Ada Example')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/contacts');
  });

  it('shows not-found for an unknown route', async () => {
    renderAt('/nowhere');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});

describe('intake', () => {
  it('refuses a contact with no name or business, and a malformed email', async () => {
    renderAt('/contacts/new');
    fireEvent.click(await screen.findByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Enter a first name, a last name or a business name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Di' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fake.calls('contacts', 'insert')).toEqual([]);
  });

  it('saves the contact and its first note, then opens the workspace', async () => {
    renderAt('/contacts/new');
    await screen.findByRole('button', { name: 'Save contact' });
    // The defaults come from the tables once they load.
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveTextContent('New lead'));
    expect(screen.getByLabelText('Source')).toHaveTextContent('Other');
    expect(screen.queryByText('Retired ad')).toBeNull();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Di' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Demo' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'di@example.com' } });
    await choose(screen.getByLabelText('Source'), 'Referral');
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
    const [note] = fake.calls('contact_notes', 'insert');
    expect(note.payload).toMatchObject({ body: 'Met at the open day.', kind: 'note', source: 'owner' });
  });

  it('shows the database error when the insert is refused', async () => {
    fake.state.errors['contacts:insert'] = { message: 'new row violates row-level security policy for table "contacts"' };
    renderAt('/contacts/new');
    fireEvent.change(await screen.findByLabelText('Business name'), { target: { value: 'Example Works' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('violates row-level security policy');
  });
});

describe('workspace overview', () => {
  it('saves only the fields that changed', async () => {
    renderAt(`/contacts/${ADA}`);
    expect(await screen.findByRole('heading', { name: 'Ada Example' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Springfield' } });
    fireEvent.change(screen.getByLabelText('Spouse first name'), { target: { value: 'Al' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const [update] = fake.calls('contacts', 'update');
    expect(update.payload).toEqual({ mailing_city: 'Springfield', spouse_first_name: 'Al' });
  });

  it('an edit typed while a save is in flight stays unsaved', async () => {
    let release!: () => void;
    fake.state.holds['contacts:update'] = new Promise<void>((r) => { release = r; });
    renderAt(`/contacts/${ADA}`);
    fireEvent.change(await screen.findByLabelText('City'), { target: { value: 'Springfield' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IL' } });
    await act(async () => { release(); });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ mailing_city: 'Springfield' });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it("shows the database's message when a save is refused", async () => {
    fake.state.errors['contacts:update'] = { message: 'permission denied for table contacts', code: '42501' };
    renderAt(`/contacts/${ADA}`);
    fireEvent.change(await screen.findByLabelText('City'), { target: { value: 'Springfield' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('permission denied for table contacts')).toBeInTheDocument();
  });

  it('adds a note as the owner', async () => {
    renderAt(`/contacts/${ADA}`);
    fireEvent.change(await screen.findByLabelText('New note'), { target: { value: 'Sent the welcome pack.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Sent the welcome pack.')).toBeInTheDocument();
    expect(fake.calls('contact_notes', 'insert')[0].payload).toEqual({
      contact_id: ADA,
      body: 'Sent the welcome pack.',
      kind: 'note',
      source: 'owner',
    });
  });

  it('keeps a note typed while the previous one was saving', async () => {
    let release!: () => void;
    fake.state.holds['contact_notes:insert'] = new Promise<void>((r) => { release = r; });
    renderAt(`/contacts/${ADA}`);
    const box = await screen.findByLabelText('New note');
    fireEvent.change(box, { target: { value: 'First.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(box, { target: { value: 'Second, still typing' } });
    await act(async () => { release(); });
    expect(await screen.findByText('First.')).toBeInTheDocument();
    expect(box).toHaveValue('Second, still typing');
  });

  it('says so when an address is added but cannot be made the default', async () => {
    fake.state.rpcErrors.contact_emails_set_default = { message: 'MFA session expired' };
    renderAt(`/contacts/${ADA}`);
    const form = await screen.findByRole('form', { name: 'Add spouse emails' });
    const input = within(form).getByLabelText('New address');
    fireEvent.change(input, { target: { value: 'al@example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The address was added but not made the default: MFA session expired');
    expect(input).toHaveValue('');
    expect(await screen.findByText('al@example.com')).toBeInTheDocument();
  });

  it('keeps an address typed while the previous one was saving', async () => {
    let release!: () => void;
    fake.state.holds['contact_emails:insert'] = new Promise<void>((r) => { release = r; });
    renderAt(`/contacts/${ADA}`);
    const form = await screen.findByRole('form', { name: 'Add spouse emails' });
    const input = within(form).getByLabelText('New address');
    fireEvent.change(input, { target: { value: 'al@example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    fireEvent.change(input, { target: { value: 'al.second@example.com' } });
    await act(async () => { release(); });
    expect(await screen.findByText('al@example.com')).toBeInTheDocument();
    expect(input).toHaveValue('al.second@example.com');
  });

  it('shows not-found for a missing contact', async () => {
    renderAt('/contacts/10000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Contact not found')).toBeInTheDocument();
  });

  it('never queries with an id that is not a uuid', async () => {
    renderAt('/contacts/not-a-uuid');
    expect(await screen.findByText('Contact not found')).toBeInTheDocument();
    await act(async () => {});
    expect(fake.calls('contacts')).toEqual([]);
  });

  it('adds an address and makes it the default through the RPC', async () => {
    renderAt(`/contacts/${ADA}`);
    const form = await screen.findByRole('form', { name: 'Add spouse emails' });
    fireEvent.change(within(form).getByLabelText('New address'), { target: { value: 'al@example.com' } });
    // No spouse address yet, so the first one is offered as the default.
    expect(within(form).getByRole('checkbox')).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('al@example.com')).toBeInTheDocument();
    const [insert] = fake.calls('contact_emails', 'insert');
    expect(insert.payload).toEqual({ contact_id: ADA, kind: 'spouse', email: 'al@example.com', label: 'other', is_default: false });
    expect(fake.state.rpcCalls.filter((r) => r.name === 'contact_emails_set_default')).toEqual([
      { name: 'contact_emails_set_default', args: { p_id: expect.any(String), p_contact_id: ADA, p_kind: 'spouse' } },
    ]);
  });

  it('deletes through the edge function and returns to the list', async () => {
    renderAt(`/contacts/${ADA}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete contact' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete contact' }));
    await waitFor(() => expect(window.location.pathname).toBe('/contacts'));
    expect(fake.state.invokeCalls).toEqual([{ name: 'delete-contact', body: { contact_id: ADA } }]);
    expect(fake.calls('contacts', 'delete')).toEqual([]);
  });
});
