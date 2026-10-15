import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  sendGroupEmail: vi.fn(),
  previewGroupEmail: vi.fn(),
}));

import { fake } from '@/__tests__/fakeSupabase';
import { queryClient } from '@/lib/queryClient';
import { EdgeError } from '@/lib/edgeCore';
import { previewGroupEmail, sendGroupEmail, type GroupEmailPreview } from '../api';
import { NewGroupEmailPage } from '../NewGroupEmailPage';

const send = vi.mocked(sendGroupEmail);
const preview = vi.mocked(previewGroupEmail);

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function contact(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    created_at: '2026-03-01T15:00:00Z',
    submitted_at: null,
    first_name: `Person${n}`,
    last_name: 'Example',
    full_name: `Person${n} Example`,
    email: `p${n}@example.com`,
    phone: null,
    business_name: null,
    status: 'client',
    source: 'other',
    ...extra,
  };
}

const PREVIEW: GroupEmailPreview = {
  preview: true,
  html: '<p>Hi</p>',
  sample: { first_name: 'Person1', address: 'p1@example.com' },
  eligible: 1,
  skipped: 0,
  delivery: 'provider',
};

function seed(count: number) {
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contact_statuses = [
    { key: 'client', label: 'Client', colour: null, sort_order: 60 },
    { key: 'lost', label: 'Lost', colour: null, sort_order: 90 },
  ];
  fake.state.tables.contacts = Array.from({ length: count }, (_, i) => contact(i + 1));
}

function renderPage(ids: string[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/email/new?to=${ids.join(',')}`]}>
        <NewGroupEmailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function compose(subject = 'A quick update', body = 'Hi {{first_name}}') {
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: subject } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: body } });
}

const review = async () => fireEvent.click(await screen.findByRole('button', { name: /^Review \d+ recipient/ }));
const keyOf = (call: number) => send.mock.calls[call][1];

beforeEach(() => {
  queryClient.clear();
  send.mockReset();
  preview.mockReset();
});

describe('the group email composer', () => {
  it('lists who will be mailed and who is skipped, and why', async () => {
    seed(2);
    fake.state.tables.contacts.push(contact(3, { status: 'lost' }), contact(4, { email: null }));
    renderPage([id(1), id(2), id(3), id(4)]);
    expect(await screen.findByText('Skipped: Lost is never emailed')).toBeInTheDocument();
    expect(screen.getByText('Skipped: No email address')).toBeInTheDocument();
    await compose();
    expect(screen.getByRole('button', { name: 'Review 2 recipients' })).toBeEnabled();
  });

  it('reuses its request id on an unedited retry, and mints a new one after an edit', async () => {
    seed(1);
    send.mockRejectedValue(new EdgeError('network'));
    renderPage([id(1)]);
    await screen.findByText('Person1 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Send 1' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Different words' } });
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('a change of recipients is a new composition too', async () => {
    seed(2);
    send.mockRejectedValue(new EdgeError('network'));
    renderPage([id(1), id(2)]);
    await screen.findByText('Person2 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 2' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Person2 Example' }));
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('after a send, the next composition gets a new request id and the result is shown', async () => {
    seed(1);
    send.mockResolvedValue({ campaign_id: id(99), sent: 1, failed: 0, skipped: 0, delivery: 'dev_outbox' });
    renderPage([id(1)]);
    await screen.findByText('Person1 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    expect(await screen.findByText(/1 written to the dev outbox/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See how each one landed' })).toHaveAttribute('href', `/email/${id(99)}`);
  });

  it('asks for the typed count from 25 recipients, not below', async () => {
    seed(25);
    send.mockResolvedValue({ campaign_id: id(99), sent: 25, failed: 0, skipped: 0, delivery: 'provider' });
    renderPage(Array.from({ length: 25 }, (_, i) => id(i + 1)));
    await screen.findByText('Person25 Example');
    await compose();
    await review();
    const sendButton = screen.getByRole('button', { name: 'Send 25' });
    expect(sendButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type 25 to confirm'), { target: { value: '24' } });
    expect(sendButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type 25 to confirm'), { target: { value: '25' } });
    expect(sendButton).toBeEnabled();
  });

  it('below 25 there is no typed confirmation', async () => {
    seed(24);
    renderPage(Array.from({ length: 24 }, (_, i) => id(i + 1)));
    await screen.findByText('Person24 Example');
    await compose();
    await review();
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send 24' })).toBeEnabled();
  });

  it('shows the preview in a sandboxed frame, with whose copy it is', async () => {
    seed(1);
    preview.mockResolvedValue(PREVIEW);
    renderPage([id(1)]);
    await screen.findByText('Person1 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = await screen.findByTitle('Group email preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Hi</p>');
    expect(screen.getByText(/As Person1 will see it \(p1@example.com\)/)).toBeInTheDocument();
  });

  it('drops a preview that arrives after the owner went back to edit', async () => {
    seed(1);
    let resolve!: (p: GroupEmailPreview) => void;
    preview.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPage([id(1)]);
    await screen.findByText('Person1 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    resolve(PREVIEW);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTitle('Group email preview')).toBeNull();
  });

  it('names a configuration refusal instead of a generic server error', async () => {
    seed(1);
    send.mockRejectedValue(new EdgeError('server', { status: 503, code: 'email_not_configured' }));
    renderPage([id(1)]);
    await screen.findByText('Person1 Example');
    await compose();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    expect(await screen.findByText(/Set RESEND_API_KEY and EMAIL_FROM/)).toBeInTheDocument();
  });
});
