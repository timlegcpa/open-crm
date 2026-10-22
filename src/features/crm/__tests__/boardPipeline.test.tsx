// The pipeline board's note line, service filter and quick add.
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  createContact: vi.fn(),
  auditContactCreate: vi.fn(),
  createQuotes: vi.fn(),
  addContactNote: vi.fn(),
  listNotesForStatuses: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/contacts', async (importOriginal) => ({ ...(await importOriginal<object>()), createContact: api.createContact }));
vi.mock('@/api/contactNotes', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addContactNote: api.addContactNote,
  listNotesForStatuses: api.listNotesForStatuses,
}));
vi.mock('@/features/crm/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  auditContactCreate: api.auditContactCreate,
  createQuotes: api.createQuotes,
}));
vi.mock('@/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<{ toast: object }>();
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { error: api.toastError }) };
});
vi.mock('@/hooks/usePickLists', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLeadSources: () => ({ data: [{ key: 'other', label: 'Other', is_active: true }, { key: 'referral', label: 'Referral', is_active: true }] }),
  useServiceTypes: () => ({
    data: [
      { key: 'retainer', label: 'Retainer', is_active: true, default_cadence: 'monthly' },
      { key: 'project', label: 'Project', is_active: true, default_cadence: 'one_time' },
      { key: 'old', label: 'Old', is_active: false, default_cadence: 'annual' },
    ],
  }),
}));
vi.mock('@/features/crm/components/quotes/CompactQuoteEditor', () => ({ CompactQuoteEditor: () => null }));
vi.mock('@/components/contacts/ContactEmailsManager', () => ({ ContactEmailsManager: () => null }));

import type { Contact, ContactService } from '@/api/contacts';
import type { ContactStatus } from '@/api/pickLists';
import { CrmBoard } from '../components/board/CrmBoard';
import { NewLeadDialog } from '../components/board/NewLeadDialog';
import { latestNotes, leadPipeline, matchesServiceFilter, quotedServiceTypes } from '../lib/board';

const quote = (service_type: string, state: 'proposed' | 'accepted' = 'proposed'): ContactService =>
  ({ id: `${service_type}-${state}`, contact_id: 'c', organization_id: null, service_type, state, cadence: 'monthly', amount: null }) as ContactService;

const person = (id: string, first: string, extra: Partial<Contact> = {}) =>
  ({
    id, first_name: first, last_name: 'Lovelace', full_name: `${first} Lovelace`, email: `${id}@example.com`, phone: null,
    business_name: null, status: 'new_lead', source: 'other', created_at: '2026-01-01T00:00:00Z', submitted_at: null,
    archived_at: null, contact_services: [], ...extra,
  }) as unknown as Contact;

describe('latestNotes', () => {
  it('keeps each contact’s first non-blank note from rows read newest first', () => {
    const notes = latestNotes([
      { contact_id: 'a', body: '   ' },
      { contact_id: 'a', body: ' Wants a call back ' },
      { contact_id: 'b', body: 'Sent the brochure' },
      { contact_id: 'a', body: 'Older note' },
    ]);
    expect([...notes]).toEqual([['a', 'Wants a call back'], ['b', 'Sent the brochure']]);
  });
});

describe('matchesServiceFilter', () => {
  const quoted = person('a', 'Ada', { contact_services: [quote('retainer'), quote('project', 'accepted')] });
  const bare = person('b', 'Grace');

  it('All matches everyone; a service matches proposed lines only', () => {
    expect(matchesServiceFilter(bare, 'all')).toBe(true);
    expect(matchesServiceFilter(quoted, 'retainer')).toBe(true);
    // Accepted work is not a quote out to the lead.
    expect(matchesServiceFilter(quoted, 'project')).toBe(false);
    expect(matchesServiceFilter(bare, 'retainer')).toBe(false);
  });

  it('the pills offer only what is quoted', () => {
    expect([...quotedServiceTypes([quoted, bare])]).toEqual(['retainer']);
  });
});

describe('leadPipeline note line', () => {
  it('carries the newest note, and null when there is none', () => {
    const [group] = leadPipeline([person('a', 'Ada'), person('b', 'Grace')], { serviceLabels: new Map(), organizations: [] }, new Map([['a', 'Call Friday']]));
    expect(Object.fromEntries(group.rows.map((r) => [r.contactId, r.note]))).toEqual({ a: 'Call Friday', b: null });
  });
});

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.createContact.mockResolvedValue('new-id');
  api.createQuotes.mockResolvedValue([]);
  api.addContactNote.mockResolvedValue(undefined);
  api.auditContactCreate.mockResolvedValue(undefined);
  api.listNotesForStatuses.mockResolvedValue([]);
});

describe('the New dialog', () => {
  const open = () => {
    const onOpenChange = vi.fn();
    wrap(<NewLeadDialog open onOpenChange={onOpenChange} stageLabel={(s) => s} />);
    return onOpenChange;
  };

  it('refuses without a first name or with an address missing its @, saving nothing', async () => {
    const onOpenChange = open();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(api.toastError.mock.calls.map((c) => c[0])).toEqual(['Add at least a first name.', 'That email address is missing an @.']);
    expect(api.createContact).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('creates the contact, then a proposed unpriced quote per service picked, then the note', async () => {
    const onOpenChange = open();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Ada ' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555 0100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Met at the fair' } });
    // An inactive service is never offered.
    expect(screen.queryByRole('button', { name: 'Old' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.createContact).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Ada', email: null, phone: '555 0100', status: 'new_lead', source: 'other' }));
    expect(api.auditContactCreate).toHaveBeenCalledWith('new-id');
    expect(api.createQuotes).toHaveBeenCalledWith([
      { contact_id: 'new-id', organization_id: null, service_type: 'project', state: 'proposed', cadence: 'one_time', amount: null },
    ]);
    expect(api.addContactNote).toHaveBeenCalledWith('new-id', 'Met at the fair', 'note');
  });

  it('a note that fails after the contact saved is said, and the dialog still closes', async () => {
    api.addContactNote.mockRejectedValue(new Error('boom'));
    const onOpenChange = open();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.toastError).toHaveBeenCalledWith('Contact saved; its note was not.', expect.anything());
    expect(api.createQuotes).not.toHaveBeenCalled();
  });

  it('a failed create keeps the dialog open with what was typed', async () => {
    api.createContact.mockRejectedValue(new Error('nope'));
    const onOpenChange = open();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('First name')).toHaveValue('Ada');
    expect(api.addContactNote).not.toHaveBeenCalled();
  });
});

describe('the board', () => {
  const statusByKey = new Map<string, ContactStatus>(
    ['new_lead', 'active_lead', 'hot', 'warm', 'cold'].map((key, i) => [key, { key, label: key, colour: null, sort_order: i } as unknown as ContactStatus]),
  );
  const board = (contacts: Contact[]) =>
    wrap(
      <CrmBoard
        contacts={contacts}
        organizations={[]}
        serviceLabels={new Map([['retainer', 'Retainer']])}
        statusByKey={statusByKey}
        search=""
        onSearch={() => {}}
        matches={() => true}
        view={null}
        onView={() => {}}
        loading={false}
        onMoveStage={async () => {}}
      />,
    );

  it('shows each card’s newest note, and narrows to a quoted service', async () => {
    api.listNotesForStatuses.mockResolvedValue([
      { id: '2', contact_id: 'a', body: 'Newest', created_at: '2026-02-02T00:00:00Z' },
      { id: '1', contact_id: 'a', body: 'Older', created_at: '2026-02-01T00:00:00Z' },
    ]);
    board([person('a', 'Ada', { contact_services: [quote('retainer')] }), person('b', 'Grace')]);
    const lane = screen.getByRole('list', { name: 'new_lead' });
    expect(await within(lane).findByText('Newest')).toBeInTheDocument();
    expect(within(lane).queryByText('Older')).toBeNull();
    expect(within(lane).getByText('Grace Lovelace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Retainer' }));
    expect(within(screen.getByRole('list', { name: 'new_lead' })).queryByText('Grace Lovelace')).toBeNull();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('offers no service filter when nothing is quoted, and New opens the quick add', () => {
    board([person('b', 'Grace')]);
    expect(screen.queryByRole('group', { name: 'Service' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.getByRole('dialog', { name: 'New contact' })).toBeInTheDocument();
  });
});
