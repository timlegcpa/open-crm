// The owner's request lists: grouped by whose move it is with Archived folded until asked,
// the New request dialog (the contact filled in where known), a revealed sensitive answer
// put away when the client changes it, and the requests strip on Documents. Fixtures are
// fictional.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import type { RequestItem, RequestWithItems } from '../lib/requests';
import { toRequest } from '../rows';

const h = vi.hoisted(() => ({
  lists: [] as unknown[],
  listError: null as Error | null,
  reveal: 'First answer',
}));

vi.mock('../api', () => ({
  listRequests: async () => {
    if (h.listError) throw h.listError;
    return h.lists;
  },
  revealAnswer: async () => h.reveal,
  acceptAll: async () => 0,
  acceptItem: async () => {},
  closeRequest: async () => {},
  deleteRequest: async () => ({ documentsDeleted: 0, cleanupOk: true }),
  remindRequest: async () => ({ status: 'reminded', email_sent: true, remaining: 0 }),
  setRemindersPaused: async () => {},
}));
vi.mock('@/hooks/useContactCandidates', () => ({
  useContactCandidates: () => ({
    contacts: { isPending: false, isError: false },
    candidates: [{ id: '10000000-0000-4000-8000-0000000000b1', name: 'Grace Hopper', detail: null, status: 'client', isClient: true }],
  }),
}));

import { RequestRoster } from '../components/RequestRoster';
import { NewRequestDialog } from '../components/NewRequestDialog';
import { RequestDetail } from '../components/RequestDetail';
import { ContactRequestsStrip } from '../components/ContactRequestsStrip';

const ADA = '10000000-0000-4000-8000-0000000000a1';

function item(fields: Partial<RequestItem> = {}): RequestItem {
  return {
    id: crypto.randomUUID(), list_id: 'list', kind: 'todo', label: 'Sign the letter', description: null, sort_order: 0, required: true,
    status: 'pending', answer_text: null, sensitive: false, has_secret_answer: false, category: 'general', tag: 'general',
    documents: [], ...fields,
  };
}

function request(title: string, status: RequestWithItems['status'], items: RequestItem[] = [], contact = ADA): RequestWithItems {
  return {
    id: crypto.randomUUID(), contact_id: contact, title, status, intro_message: null, include_contact_confirm: false,
    reminders_paused: false, reminder_count: 0, last_reminded_at: null, created_at: '2026-01-01T00:00:00Z',
    sent_at: status === 'draft' ? null : '2026-01-02T00:00:00Z', submitted_at: null, closed_at: null, content_version: 1, items,
  };
}

function Where() {
  const at = useLocation();
  return <p data-testid="where">{`${at.pathname}${at.search}`}</p>;
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.lists = [];
  h.listError = null;
  h.reveal = 'First answer';
});

describe('the roster', () => {
  it('shows what is open by whose move it is, and keeps Archived folded until asked', () => {
    wrap(
      <RequestRoster
        requests={[
          request('Handed back', 'submitted'),
          request('Out with the client', 'sent', [item()]),
          request('Answered, to accept', 'sent', [item({ status: 'fulfilled' })]),
          request('Finished', 'closed'),
        ]}
        contactName={() => 'Ada Lovelace'}
      />,
    );
    expect(screen.getByText('Waiting on you (2)')).toBeTruthy();
    expect(screen.getByText('Waiting on client (1)')).toBeTruthy();
    expect(screen.queryByText('Finished')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show archived (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide archived' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('says nothing is open when every request is archived', () => {
    wrap(<RequestRoster requests={[request('Finished', 'closed')]} />);
    expect(screen.getByText('Nothing open.')).toBeTruthy();
  });
});

describe('the New request dialog', () => {
  it('waits for a contact, then opens the builder for the one chosen', async () => {
    wrap(<NewRequestDialog open onOpenChange={() => {}} />);
    const next = screen.getByRole('button', { name: 'Next' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Contact/ }));
    fireEvent.click(await screen.findByText('Grace Hopper'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('where').textContent).toBe('/requests/new?contact=10000000-0000-4000-8000-0000000000b1');
  });

  it('starts with the contact filled in where it is known', () => {
    wrap(<NewRequestDialog open onOpenChange={() => {}} defaultContact={{ id: ADA, name: 'Ada Lovelace' }} />);
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('where').textContent).toBe(`/requests/new?contact=${ADA}`);
  });
});

describe('a revealed sensitive answer', () => {
  it('is put away when the client changes the answer, and the new one is revealed on request', async () => {
    const secret = (key: string) => item({ id: 'secret-item', kind: 'question', label: 'Account reference', sensitive: true, has_secret_answer: true, secret_answer_key: key, status: 'fulfilled' });
    const first = request('Details', 'sent', [secret('a')]);
    // The same request read again after the client changed the answer: same ids, new ciphertext.
    const second = { ...first, items: [secret('b')] };
    function Refetched() {
      const [shown, setShown] = useState(first);
      return (
        <>
          <RequestDetail request={shown} />
          <button type="button" onClick={() => setShown(second)}>Refetch</button>
        </>
      );
    }
    wrap(<Refetched />);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    expect(await screen.findByText('First answer')).toBeTruthy();

    h.reveal = 'Corrected answer';
    fireEvent.click(screen.getByRole('button', { name: 'Refetch' }));
    expect(screen.queryByText('First answer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal answer' }));
    expect(await screen.findByText('Corrected answer')).toBeTruthy();
  });

  it('carries a tag that follows the stored ciphertext and holds none of it', () => {
    const raw = (cipher: string | null) => ({
      id: 'l', contact_id: ADA, title: 'T', status: 'sent', intro_message: null, include_contact_confirm: false, reminders_paused: false,
      reminder_count: 0, last_reminded_at: null, created_at: 'x', sent_at: null, submitted_at: null, closed_at: null, content_version: 1,
      needs_items: [{ id: 'i', list_id: 'l', kind: 'question', label: 'Q', description: null, sort_order: 0, required: true, status: 'fulfilled',
        answer_text: null, sensitive: true, answer_ciphertext: cipher, category: 'general', tag: 'general', needs_item_documents: [] }],
    });
    const key = (cipher: string | null) => toRequest(raw(cipher)).items[0].secret_answer_key;
    expect(key(null)).toBeNull();
    expect(key('\\x')).toBeNull();
    expect(key('\\x0a0b0c0d')).toBe(key('\\x0a0b0c0d'));
    expect(key('\\x0a0b0c0d')).not.toBe(key('\\x0a0b0c0e'));
    expect(key('\\x0a0b0c0d')).not.toContain('0a0b');
    expect(toRequest(raw('\\x0a0b0c0d')).items[0].has_secret_answer).toBe(true);
  });
});

describe('the requests on Documents', () => {
  it('counts what is open, folds the archived, and offers a New request for the contact', async () => {
    h.lists = [request('Out with the client', 'sent', [item()]), request('Finished', 'closed')];
    wrap(<ContactRequestsStrip contactId={ADA} contactName="Ada Lovelace" />);
    expect(await screen.findByRole('button', { name: 'Requests (1 open)' })).toBeTruthy();
    expect(screen.getByText('Out with the client')).toBeTruthy();
    expect(screen.queryByText('Finished')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('where').textContent).toBe(`/requests/new?contact=${ADA}`);
  });

  it('says so when the requests could not be read, rather than nothing open', async () => {
    h.listError = new Error('Network down');
    wrap(<ContactRequestsStrip contactId={ADA} contactName="Ada Lovelace" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load requests'));
    expect(screen.queryByText('Nothing open.')).toBeNull();
  });
});
