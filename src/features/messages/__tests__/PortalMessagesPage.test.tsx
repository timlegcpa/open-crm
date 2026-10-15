import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: { user: { id: 'client-1' } }, clientContactId: 'contact-1' }),
}));
const api = vi.hoisted(() => ({
  listMyMessages: vi.fn(),
  countUnreadReplies: vi.fn(),
  markRepliesRead: vi.fn(),
  getOrgPublicKey: vi.fn(),
  sendEncrypted: vi.fn(),
  isViewAsClient: vi.fn(),
  getOrgName: vi.fn(),
}));
vi.mock('../portalApi', () => api);

import { fake } from './fakeClient';
import { PortalMessagesPage } from '../portal';

const KEY = { key_id: 'key-1', public_key: '{}' };

function reply(id: string, readAt: string | null = null) {
  return {
    id, contact_id: 'contact-1', sender_role: 'owner', body: `Reply ${id}`, is_encrypted: false,
    encrypted_body: null, encrypted_key: null, encryption_iv: null, key_id: null, read_at: readAt,
    created_at: `2030-01-01T00:00:0${id.length}Z`,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortalMessagesPage />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  fake.reset();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listMyMessages.mockResolvedValue([]);
  api.countUnreadReplies.mockResolvedValue(0);
  api.markRepliesRead.mockResolvedValue(true);
  api.getOrgPublicKey.mockResolvedValue(KEY);
  api.isViewAsClient.mockResolvedValue(false);
  api.getOrgName.mockResolvedValue('Acme LLC');
});

describe('the portal Messages page', () => {
  it('sends once when Enter and a click land in the same tick', async () => {
    let finish!: (id: string) => void;
    api.sendEncrypted.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderPage();
    const box = await screen.findByLabelText('New message to Acme LLC');
    fireEvent.change(box, { target: { value: 'Here is the signed form.' } });
    const send = screen.getByRole('button', { name: 'Send securely' });
    act(() => {
      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.click(send);
    });
    expect(api.sendEncrypted).toHaveBeenCalledTimes(1);
    expect(api.sendEncrypted).toHaveBeenCalledWith('Here is the signed form.', KEY, 'contact-1', 'client-1');
    await act(async () => finish('new-1'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps the draft when sending fails', async () => {
    api.sendEncrypted.mockRejectedValue(new Error('offline'));
    renderPage();
    const box = await screen.findByLabelText('New message to Acme LLC');
    fireEvent.change(box, { target: { value: 'Do not lose me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send securely' }));
    await waitFor(() => expect(api.sendEncrypted).toHaveBeenCalled());
    expect(box).toHaveValue('Do not lose me');
  });

  it('shows the text just sent, and an earlier message of its own as encrypted', async () => {
    const mine = (id: string) => ({ ...reply(id), sender_role: 'client', body: null, is_encrypted: true });
    api.listMyMessages.mockResolvedValue([mine('old')]);
    api.sendEncrypted.mockResolvedValue('new');
    renderPage();
    expect(await screen.findByText('Encrypted message')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('New message to Acme LLC'), { target: { value: 'Fresh note' } });
    api.listMyMessages.mockResolvedValue([mine('old'), mine('new')]);
    fireEvent.click(screen.getByRole('button', { name: 'Send securely' }));
    expect(await screen.findByText('Fresh note')).toBeInTheDocument();
  });

  it('marks the owner\'s unread replies read once', async () => {
    api.listMyMessages.mockResolvedValue([reply('a'), reply('bb', '2030-01-02T00:00:00Z'), reply('ccc')]);
    const client = renderPage();
    await waitFor(() => expect(api.markRepliesRead).toHaveBeenCalledTimes(1));
    expect(api.markRepliesRead).toHaveBeenCalledWith(['a', 'ccc'], 'contact-1', 'client-1');
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(api.listMyMessages).toHaveBeenCalledTimes(2));
    expect(api.markRepliesRead).toHaveBeenCalledTimes(1);
  });

  it('tries again on a later refetch when marking read failed', async () => {
    // A fresh array per fetch, as the network gives.
    api.listMyMessages.mockImplementation(async () => [reply('a')]);
    api.markRepliesRead.mockResolvedValueOnce(false);
    const client = renderPage();
    await waitFor(() => expect(api.markRepliesRead).toHaveBeenCalledTimes(1));
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(api.markRepliesRead).toHaveBeenCalledTimes(2));
    expect(api.markRepliesRead).toHaveBeenLastCalledWith(['a'], 'contact-1', 'client-1');
    // Once it succeeded, a further refetch sends nothing.
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(api.listMyMessages).toHaveBeenCalledTimes(3));
    expect(api.markRepliesRead).toHaveBeenCalledTimes(2);
  });

  it('under View as client: reads, but cannot send and marks nothing read', async () => {
    api.isViewAsClient.mockResolvedValue(true);
    api.listMyMessages.mockResolvedValue([reply('a')]);
    renderPage();
    expect(await screen.findByText('Reply a')).toBeInTheDocument();
    expect(await screen.findByLabelText('New message to Acme LLC')).toBeDisabled();
    expect(screen.getByText('Sending is off while viewing as client.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send securely' })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.markRepliesRead).not.toHaveBeenCalled();
  });

  it('listens only for new messages on its own contact', async () => {
    renderPage();
    await waitFor(() => expect(fake.state.channels.filter((c) => !c.removed)).toHaveLength(1));
    const live = fake.state.channels.filter((c) => !c.removed);
    expect(live[0].config).toMatchObject({ event: 'INSERT', table: 'client_messages', filter: 'contact_id=eq.contact-1' });
    await waitFor(() => expect(api.listMyMessages).toHaveBeenCalledTimes(1));
    act(() => fake.emitChange('INSERT', 'contact-1'));
    await waitFor(() => expect(api.listMyMessages).toHaveBeenCalledTimes(2));
  });

  it('says so when secure messages are not set up yet', async () => {
    api.getOrgPublicKey.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('Secure messages are not available yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('New message to Acme LLC')).toBeNull();
  });
});
