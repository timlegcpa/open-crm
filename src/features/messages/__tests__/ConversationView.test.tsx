import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: { user: { id: 'owner-1' } } }) }));
const api = vi.hoisted(() => ({
  listConversation: vi.fn(),
  markClientMessagesRead: vi.fn(),
  sendReply: vi.fn(),
  deleteMessages: vi.fn(),
}));
vi.mock('../api', () => api);
const crypto = vi.hoisted(() => ({ decryptMessage: vi.fn(), MESSAGE_MAX_LENGTH: 10_000 }));
vi.mock('../crypto', () => crypto);

import { fake } from './fakeClient';
import { ConversationView } from '../components/ConversationView';

const KEY = {} as CryptoKey;

function row(id: string, role: 'owner' | 'client', fields: Record<string, unknown> = {}) {
  return {
    id, contact_id: 'contact-1', sender_role: role, body: role === 'owner' ? `Owner ${id}` : null,
    is_encrypted: role === 'client', encrypted_body: role === 'client' ? 'c' : null, encrypted_key: role === 'client' ? 'k' : null,
    encryption_iv: role === 'client' ? 'v' : null, key_id: null, read_at: null, created_at: '2030-01-01T00:00:00Z', ...fields,
  };
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConversationView contactId="contact-1" contactName="Ada Lovelace" privateKey={KEY} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fake.reset();
  Object.values(api).forEach((fn) => fn.mockReset());
  crypto.decryptMessage.mockReset();
  api.listConversation.mockResolvedValue([row('m1', 'client'), row('m2', 'owner'), row('m3', 'client')]);
  api.markClientMessagesRead.mockResolvedValue(undefined);
  crypto.decryptMessage.mockImplementation(async (body: string) => {
    if (body === 'bad') throw new Error('wrong key');
    return 'Opened text';
  });
});

describe('the owner conversation', () => {
  it('opens client messages, shows replies, and marks unread client messages read', async () => {
    api.listConversation.mockResolvedValue([row('m1', 'client'), row('m2', 'owner'), row('m3', 'client', { encrypted_body: 'bad' })]);
    renderView();
    expect(await screen.findByText('Opened text')).toBeInTheDocument();
    expect(screen.getByText('Owner m2')).toBeInTheDocument();
    expect(screen.getByText('This message could not be opened with your key.')).toBeInTheDocument();
    await waitFor(() => expect(api.markClientMessagesRead).toHaveBeenCalledWith(['m1', 'm3']));
  });

  it('keeps the draft when the reply fails, and clears it once sent', async () => {
    api.sendReply.mockRejectedValueOnce(new Error('offline'));
    renderView();
    const box = await screen.findByLabelText('Reply to Ada Lovelace');
    fireEvent.change(box, { target: { value: 'On my way' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.sendReply).toHaveBeenCalledWith('contact-1', 'owner-1', 'On my way'));
    expect(box).toHaveValue('On my way');
    api.sendReply.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('follows reads and deletes made from another session, not only new messages', async () => {
    renderView();
    await waitFor(() => expect(api.listConversation).toHaveBeenCalledTimes(1));
    for (const [event, contact] of [['UPDATE', 'contact-1'], ['DELETE', null], ['INSERT', 'contact-1']] as const) {
      const before = api.listConversation.mock.calls.length;
      act(() => fake.emitChange(event, contact));
      await waitFor(() => expect(api.listConversation.mock.calls.length).toBeGreaterThan(before));
    }
  });

  it('asks before deleting the whole conversation', async () => {
    api.deleteMessages.mockResolvedValue(undefined);
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    expect(api.deleteMessages).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.bg-destructive') as HTMLElement);
    await waitFor(() => expect(api.deleteMessages).toHaveBeenCalledWith(['m1', 'm2', 'm3']));
  });
});
