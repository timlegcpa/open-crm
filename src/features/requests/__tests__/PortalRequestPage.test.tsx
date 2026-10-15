// The client's request page: an answer saves on its own after a pause and on leaving the
// box, only when it changed; an empty sensitive box never erases a stored answer; Submit
// waits for every required item and every save in flight; View as client changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RequestItem, RequestWithItems } from '../lib/requests';

const CONTACT = '10000000-0000-4000-8000-000000000001';
const LIST = '00000000-0000-4000-8000-0000000000aa';

const h = vi.hoisted(() => ({
  request: null as unknown,
  viewing: false,
  saves: [] as Array<{ action: string; args: unknown[] }>,
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ clientContactId: CONTACT, isViewAsClientSession: h.viewing }) }));
vi.mock('@/features/portal/api', () => ({
  getMyContact: async () => null,
  portalKeys: { myContact: () => ['portal', 'my-contact'] },
}));
vi.mock('../portalApi', () => ({
  CONFIRM_FIELDS: ['first_name'],
  getMyRequest: async () => h.request,
  listMyRequests: async () => [],
  subscribeToMyRequests: () => () => {},
  ensureRequestFolder: async () => {},
  uploadToItem: async () => 'linked',
  saveContactDetails: async () => 'saved',
  saveAnswer: async (...args: unknown[]) => {
    h.saves.push({ action: 'save_answer', args });
    return 'fulfilled';
  },
  markItem: async (...args: unknown[]) => {
    h.saves.push({ action: 'mark_item', args });
    return 'fulfilled';
  },
  submitRequest: async (...args: unknown[]) => {
    h.saves.push({ action: 'submit', args });
    return 'submitted';
  },
}));

import { AUTOSAVE_MS, PortalRequestPage } from '../portal';

function item(id: string, fields: Partial<RequestItem>): RequestItem {
  return {
    id, list_id: LIST, kind: 'question', label: `Item ${id}`, description: null, sort_order: 0, required: true, status: 'pending',
    answer_text: null, sensitive: false, has_secret_answer: false, category: 'general', tag: 'general', documents: [], ...fields,
  };
}

function request(items: RequestItem[], fields: Partial<RequestWithItems> = {}): RequestWithItems {
  return {
    id: LIST, contact_id: CONTACT, title: 'Onboarding', status: 'sent', intro_message: null, include_contact_confirm: false,
    reminders_paused: false, reminder_count: 0, last_reminded_at: null, created_at: '2026-06-01T00:00:00Z', sent_at: '2026-06-02T00:00:00Z',
    submitted_at: null, closed_at: null, content_version: 1, items, ...fields,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/portal/requests/${LIST}`]}>
        <Routes>
          <Route path="/portal/requests/:id" element={<PortalRequestPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.saves = [];
  h.viewing = false;
});
afterEach(() => vi.useRealTimers());

describe('the portal request page', () => {
  it('saves an answer after a pause, once, and not again on an unchanged blur', async () => {
    h.request = request([item('q1', {})]);
    renderPage();
    const box = await screen.findByRole('textbox', { name: 'Item q1' });
    vi.useFakeTimers();
    fireEvent.change(box, { target: { value: 'Yes' } });
    expect(h.saves).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    vi.useRealTimers();
    await waitFor(() => expect(h.saves).toEqual([{ action: 'save_answer', args: ['q1', 'Yes'] }]));
    fireEvent.blur(box);
    expect(h.saves).toHaveLength(1);
  });

  it('never erases a stored sensitive answer with an empty box', async () => {
    h.request = request([item('s1', { sensitive: true, has_secret_answer: true, required: false })]);
    renderPage();
    const box = await screen.findByRole('textbox', { name: /Item s1/ });
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/saved securely/)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);
    await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 50));
    expect(h.saves).toEqual([]);
  });

  it('allows Submit only when every required item is done', async () => {
    h.request = request([item('t1', { kind: 'todo' }), item('i1', { kind: 'info' })]);
    renderPage();
    const submit = await screen.findByRole('button', { name: 'Submit' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('1 required item is still open.')).toBeTruthy();
  });

  it('submits a complete request', async () => {
    h.request = request([item('t1', { kind: 'todo', status: 'fulfilled' }), item('i1', { kind: 'info' })]);
    renderPage();
    const ready = await screen.findByRole('button', { name: 'Submit' });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ready);
    await waitFor(() => expect(h.saves).toEqual([{ action: 'submit', args: [LIST] }]));
  });

  it('changes nothing while viewing as the client', async () => {
    h.viewing = true;
    h.request = request([item('q1', {}), item('t1', { kind: 'todo', status: 'fulfilled' })]);
    renderPage();
    const box = await screen.findByRole('textbox', { name: 'Item q1' });
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/viewing as the client/)).toBeTruthy();
  });

  it('shows a submitted request read only', async () => {
    h.request = request([item('q1', { answer_text: 'Yes', status: 'reviewed' })], { status: 'submitted' });
    renderPage();
    expect(await screen.findByText(/You submitted this request/)).toBeTruthy();
    expect(((await screen.findByRole('textbox', { name: 'Item q1' })) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});
