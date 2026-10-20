import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import ShareDocumentDialog from '../explorer/ShareDocumentDialog';

const OWNER = '10000000-0000-4000-8000-00000000000a';
const SPOUSE = '10000000-0000-4000-8000-00000000000b';
const GONE = '10000000-0000-4000-8000-00000000000c';

const person = (id: string, name: string, archived_at: string | null = null) => ({
  id,
  first_name: name,
  last_name: 'Example',
  full_name: `${name} Example`,
  business_name: null,
  archived_at,
});

function open(sharedWithContactId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShareDocumentDialog target={{ id: 'd1', name: 'return.pdf', contactId: OWNER, sharedWithContactId }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contacts = [person(OWNER, 'Ada'), person(SPOUSE, 'Bo'), person(GONE, 'Cy', '2026-03-05T10:00:00Z')];
  fake.state.tables.contact_relationships = [
    { id: 'r1', contact_id: OWNER, related_contact_id: SPOUSE, relationship: 'spouse', created_at: '2026-01-01' },
    { id: 'r2', contact_id: OWNER, related_contact_id: GONE, relationship: 'dependent', created_at: '2026-01-02' },
  ];
});

describe('ShareDocumentDialog and the archive', () => {
  it('never offers an archived linked person', async () => {
    open(null);
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: 'Bo Example (spouse)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Cy Example/ })).toBeNull();
  });

  it('keeps an archived person the document is already shared with, so opening it changes nothing', async () => {
    open(GONE);
    expect(await screen.findByRole('combobox')).toHaveTextContent('Cy Example (dependent)');
  });
});
