import { useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);
// The editor's own behaviour is pinned with the board's card bar; here it is a probe for
// what the record hands it.
vi.mock('@/features/crm/components/quotes/CompactQuoteEditor', () => ({
  CompactQuoteEditor: (p: { contact: { id: string }; disabled?: boolean }) => (
    <span data-testid="quote-editor" data-contact={p.contact.id} data-disabled={String(!!p.disabled)} />
  ),
}));
vi.mock('@/components/contacts/ContactEmailsManager', () => ({ ContactEmailsManager: () => null }));
vi.mock('@/components/contacts/HouseholdPanel', () => ({ HouseholdPanel: () => null }));
vi.mock('@/components/contacts/ContactNotesCard', () => ({ ContactNotesCard: () => null }));
vi.mock('@/features/registry', async (importOriginal) => ({ ...(await importOriginal<object>()), contactSidePanels: [] }));

import type { Contact } from '@/api/contacts';
import { fake } from '@/__tests__/fakeSupabase';
import { BillingTab } from '../components/BillingTab';
import { OverviewTab } from '../components/OverviewTab';
import { RecordRightBar } from '../components/RecordRightBar';
import { contactFieldMutationKey } from '../hooks';
import { quoteOpMutationKey } from '../lib/quotes';
import { useQuoteEditing } from '../useQuoteEditing';

const ADA = '10000000-0000-4000-8000-00000000000a';

const CONTACT: Contact = {
  id: ADA,
  created_at: '2026-03-01T15:00:00Z',
  updated_at: '2026-03-01T15:00:00Z',
  submitted_at: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  business_name: 'Acme LLC',
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
  tier: null,
  archived_at: null,
  contact_services: [],
};

/** Holds a mutation under `key` open for the whole test, as a slow network would. */
function PendingSave({ mutationKey }: { mutationKey: readonly unknown[] }) {
  const { mutate } = useMutation({ mutationKey, mutationFn: () => new Promise<void>(() => {}) });
  useEffect(() => mutate(), [mutate]);
  return null;
}

function renderWith(node: JSX.Element, pending?: readonly unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {pending && <PendingSave mutationKey={pending} />}
        {node}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The select trigger labelled `label` inside `scope`. */
const select = (label: string, scope: HTMLElement = document.body) => within(scope).getByRole('combobox', { name: label });

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contact_statuses = [
    { key: 'new_lead', label: 'New', colour: null, sort_order: 10 },
    { key: 'client', label: 'Client', colour: null, sort_order: 60 },
    { key: 'esign_signer', label: 'Signer only', colour: null, sort_order: 100 },
  ];
  fake.state.tables.lead_sources = [{ key: 'other', label: 'Other', colour: null, sort_order: 10, is_active: true }];
  fake.state.tables.contacts = [{ ...CONTACT }];
});

describe('Overview billing', () => {
  it('puts the services editor for this contact on Overview, with a link to Billing', async () => {
    renderWith(<OverviewTab contact={CONTACT} />);
    const editor = await screen.findByTestId('quote-editor');
    expect(editor.dataset.contact).toBe(ADA);
    expect(screen.getByRole('link', { name: 'Open billing' })).toHaveAttribute('href', `/contacts/${ADA}/billing`);
  });

  // A quote save re-derives the status from the one it read, so each waits for the other.
  it('holds the quotes while a field save for this contact is in flight', async () => {
    renderWith(<OverviewTab contact={CONTACT} />, contactFieldMutationKey(ADA));
    await waitFor(async () => expect((await screen.findByTestId('quote-editor')).dataset.disabled).toBe('true'));
  });

  it('holds the status while a quote save is in flight', async () => {
    renderWith(<OverviewTab contact={CONTACT} />, quoteOpMutationKey(ADA));
    await waitFor(() => expect(select('Status')).toBeDisabled());
  });

  it('holds the quotes while the owner’s own status change is saving', async () => {
    let release = () => {};
    fake.state.holds['contacts:update'] = new Promise<void>((r) => {
      release = r;
    });
    renderWith(<OverviewTab contact={CONTACT} />);
    expect((await screen.findByTestId('quote-editor')).dataset.disabled).toBe('false');
    await waitFor(() => expect(select('Status')).toBeEnabled());
    fireEvent.keyDown(select('Status'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Client' }));
    await waitFor(() => expect(screen.getByTestId('quote-editor').dataset.disabled).toBe('true'));
    release();
    await waitFor(() => expect(screen.getByTestId('quote-editor').dataset.disabled).toBe('false'));
  });

  it('leaves both open when nothing is saving', async () => {
    renderWith(<OverviewTab contact={CONTACT} />);
    expect((await screen.findByTestId('quote-editor')).dataset.disabled).toBe('false');
    await waitFor(() => expect(select('Status')).toBeEnabled());
  });
});

describe('the tier field', () => {
  it('saves a tier, and "Not ranked" saves null', async () => {
    fake.state.tables.contacts = [{ ...CONTACT, tier: 'B' }];
    renderWith(<OverviewTab contact={{ ...CONTACT, tier: 'B' }} />);
    const tier = select('Tier');
    expect(tier).toHaveTextContent('B tier');
    fireEvent.keyDown(tier, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Not ranked' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(1));
    expect(fake.calls('contacts', 'update')[0].payload).toEqual({ tier: null });
    fireEvent.keyDown(select('Tier'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'S tier' }));
    await waitFor(() => expect(fake.calls('contacts', 'update')).toHaveLength(2));
    expect(fake.calls('contacts', 'update')[1].payload).toEqual({ tier: 'S' });
  });
});

describe('the record right bar', () => {
  it('quick-edits status, tier, phone and source, and copies the rest (never email or phone)', async () => {
    renderWith(<RecordRightBar contact={CONTACT} />);
    const edit = screen.getByRole('region', { name: 'Quick edit' });
    expect(select('Status', edit)).toBeInTheDocument();
    expect(select('Tier', edit)).toBeInTheDocument();
    expect(select('Source', edit)).toBeInTheDocument();
    expect(within(edit).getByRole('button', { name: /^Phone:/ })).toBeInTheDocument();
    const copy = screen.getByRole('region', { name: 'Quick copy' });
    expect(within(copy).getByRole('button', { name: 'Copy business: Acme LLC' })).toBeInTheDocument();
    expect(within(copy).queryByRole('button', { name: /Copy email/ })).toBeNull();
  });

  it('shows a system status without offering it', async () => {
    renderWith(<RecordRightBar contact={{ ...CONTACT, status: 'esign_signer' }} />);
    const edit = screen.getByRole('region', { name: 'Quick edit' });
    expect(within(edit).queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(await within(edit).findByText('Signer only')).toBeInTheDocument();
  });

  it('carries the services editor only where the tab body does not, and never on a terminal status', async () => {
    const view = renderWith(<RecordRightBar contact={CONTACT} />);
    expect(await screen.findByTestId('quote-editor')).toBeInTheDocument();
    view.unmount();
    const hidden = renderWith(<RecordRightBar contact={CONTACT} showServices={false} />);
    expect(screen.queryByTestId('quote-editor')).toBeNull();
    hidden.unmount();
    renderWith(<RecordRightBar contact={{ ...CONTACT, status: 'lost' }} />);
    expect(screen.queryByTestId('quote-editor')).toBeNull();
  });

  it('holds the status while a quote saves, and the quotes while a field saves', async () => {
    const quote = renderWith(<RecordRightBar contact={CONTACT} />, quoteOpMutationKey(ADA));
    await waitFor(() => expect(select('Status', screen.getByRole('region', { name: 'Quick edit' }))).toBeDisabled());
    quote.unmount();
    renderWith(<RecordRightBar contact={CONTACT} />, contactFieldMutationKey(ADA));
    await waitFor(async () => expect((await screen.findByTestId('quote-editor')).dataset.disabled).toBe('true'));
  });
});

describe('the Billing tab and a field save', () => {
  const QUOTE = {
    id: '20000000-0000-4000-8000-000000000001',
    contact_id: ADA,
    organization_id: null,
    service_type: 'retainer',
    state: 'accepted',
    cadence: 'monthly',
    amount: '500.00',
  };
  const CLIENT = { ...CONTACT, status: 'client', contact_services: [QUOTE] } as unknown as Contact;

  beforeEach(() => {
    fake.state.tables.contacts = [{ ...CLIENT }];
    fake.state.tables.contact_services = [{ ...QUOTE }];
  });

  // A quote save re-derives the status from the one it read: it must not start while the
  // owner's own status change (from the right bar, say) is saving.
  it('holds its quotes while a field save for this contact is in flight', async () => {
    renderWith(<BillingTab contactId={ADA} />, contactFieldMutationKey(ADA));
    await waitFor(() => expect(screen.getByRole('button', { name: /price:/ })).toBeDisabled());
  });

  it('leaves its quotes open when nothing is saving', async () => {
    renderWith(<BillingTab contactId={ADA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /price:/ })).toBeEnabled());
  });

  it('refuses a quote write that starts while a field save is in flight', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <PendingSave mutationKey={contactFieldMutationKey(ADA)} />
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useQuoteEditing({ id: ADA }), { wrapper });
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(await result.current.patchQuote({ id: QUOTE.id }, { amount: 900 })).toBe(false);
    expect(fake.calls('contact_services', 'update')).toHaveLength(0);
    expect(fake.calls('contacts', 'update')).toHaveLength(0);
  });
});
