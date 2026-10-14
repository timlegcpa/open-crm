import { lazy } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ContactHeaderAction, ContactSidePanel, ContactTab, ContactTabProps } from '@/features/types';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

// A registry with one feature filling every contact-record slot, as a domain manifest would.
const { asLazy } = vi.hoisted(() => ({
  asLazy: (render: (props: ContactTabProps) => JSX.Element) => lazy(async () => ({ default: render })),
}));

vi.mock('@/features/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registry')>();
  const contactTabs: ContactTab[] = [
    { key: 'files', label: 'Files', order: 10, Component: asLazy(({ contactId }) => <p>Files of {contactId}</p>), badge: asLazy(() => <span title="Waiting">2</span>) },
    { key: 'notes-extra', label: 'Later tab', order: 20, Component: asLazy(() => <p>Later tab body</p>) },
  ];
  const contactHeaderActions: ContactHeaderAction[] = [
    { key: 'send', order: 10, Component: asLazy(({ contactId }) => <button type="button">Send to {contactId.slice(-1)}</button>) },
  ];
  const contactSidePanels: ContactSidePanel[] = [
    { key: 'summary', order: 10, Component: asLazy(() => <section aria-label="Access">Portal access: none</section>) },
  ];
  return { ...actual, contactTabs, contactHeaderActions, contactSidePanels };
});

import { fake } from '@/__tests__/fakeSupabase';
import { ContactWorkspace } from '@/pages/contacts/ContactWorkspace';

const ADA = '10000000-0000-4000-8000-00000000000a';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="contacts/:id" element={<ContactWorkspace />} />
          <Route path="contacts/:id/:tab" element={<ContactWorkspace />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contact_statuses = [{ key: 'client', label: 'Client', colour: null, sort_order: 60 }];
  fake.state.tables.contacts = [
    {
      id: ADA,
      created_at: '2026-03-01T15:00:00Z',
      updated_at: '2026-03-01T15:00:00Z',
      submitted_at: null,
      first_name: 'Ada',
      last_name: 'Lovelace',
      full_name: 'Ada Lovelace',
      email: null,
      phone: null,
      business_name: null,
      status: 'client',
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
    },
  ];
});

describe('contact record slots', () => {
  it('renders registered tabs as links in order, with Overview first and open by default', async () => {
    renderAt(`/contacts/${ADA}`);
    const nav = await screen.findByRole('navigation', { name: 'Contact sections' });
    const tabs = within(nav).getAllByRole('link');
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual([
      `/contacts/${ADA}`,
      `/contacts/${ADA}/files`,
      `/contacts/${ADA}/notes-extra`,
    ]);
    expect(tabs[0]).toHaveAttribute('aria-current', 'page');
    expect(tabs[1]).not.toHaveAttribute('aria-current');
    expect(await within(tabs[1]).findByTitle('Waiting')).toHaveTextContent('2');
  });

  it("opens a feature's tab at its own URL and hands it the contact id", async () => {
    renderAt(`/contacts/${ADA}/files`);
    expect(await screen.findByText(`Files of ${ADA}`)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Contact sections' });
    expect(within(nav).getByRole('link', { name: /Files/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('sends an unknown tab back to the record', async () => {
    renderAt(`/contacts/${ADA}/nope`);
    expect(await screen.findByTestId('where')).toHaveTextContent(`/contacts/${ADA}`);
    expect(screen.getByTestId('where').textContent).toBe(`/contacts/${ADA}`);
  });

  it('renders header actions beside Delete, and side panels in the right bar', async () => {
    renderAt(`/contacts/${ADA}`);
    expect(await screen.findByRole('button', { name: 'Send to a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete contact' })).toBeInTheDocument();
    const bar = screen.getByRole('complementary', { name: 'Contact summary', hidden: true });
    expect(await within(bar).findByText('Portal access: none')).toBeInTheDocument();
  });
});
