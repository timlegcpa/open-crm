import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);

import { fake } from '@/__tests__/fakeSupabase';
import { GroupEmailHistory } from '../GroupEmailHistory';

const ADA = '10000000-0000-4000-8000-00000000000a';
const GRACE = '10000000-0000-4000-8000-00000000000b';
const CAMPAIGN = '20000000-0000-4000-8000-000000000001';

function recipient(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `30000000-0000-4000-8000-00000000000${n}`,
    campaign_id: CAMPAIGN,
    contact_id: ADA,
    address: 'ada@example.com',
    status: 'sent',
    error: null,
    sent_at: '2026-10-01T15:00:00Z',
    created_at: `2026-10-0${n}T14:00:00Z`,
    campaign: { id: CAMPAIGN, subject: `Update ${n}`, sent_at: '2026-10-01T15:00:00Z' },
    ...extra,
  };
}

function renderFor(contactId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GroupEmailHistory contactId={contactId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset();
});

describe('GroupEmailHistory', () => {
  it("lists only this contact's group emails, newest first, each linking to its campaign", async () => {
    fake.state.tables.crm_email_recipients = [
      recipient(1),
      recipient(2, { status: 'unknown' }),
      recipient(3, { contact_id: GRACE, address: 'grace@example.com' }),
    ];
    renderFor(ADA);
    const links = await screen.findAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Update 2', `/email/${CAMPAIGN}`],
      ['Update 1', `/email/${CAMPAIGN}`],
    ]);
    expect(screen.getByText('Unconfirmed')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(fake.calls('crm_email_recipients', 'select')[0].filters).toContainEqual({ type: 'eq', column: 'contact_id', value: ADA });
  });

  it('a send whose campaign is gone still shows, without a link', async () => {
    fake.state.tables.crm_email_recipients = [recipient(1, { campaign: null })];
    renderFor(ADA);
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing when the contact was never sent a group email', async () => {
    const { container } = renderFor(ADA);
    await waitFor(() => expect(fake.calls('crm_email_recipients', 'select')).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('says so when the list cannot load', async () => {
    fake.state.errors['crm_email_recipients:select'] = { message: 'permission denied' };
    renderFor(ADA);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load group emails.');
  });
});
