// The record's Portal section: one action per address by its account's state, the link
// shown when the email did not go out, one switch write at a time, and View as client
// started only after the owner confirms.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  view: null as unknown,
  sendInvite: vi.fn(),
  resendInvite: vi.fn(),
  revokeAccess: vi.fn(),
  setFlag: vi.fn(),
  startViewAsClient: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ startViewAsClient: h.startViewAsClient }) }));
vi.mock('../api', () => ({
  portalKeys: { access: (id: string) => ['portal', 'access', id] },
  getPortalAccess: async () => h.view,
  sendInvite: h.sendInvite,
  resendInvite: h.resendInvite,
  revokeAccess: h.revokeAccess,
  setPortalSidebarFlag: h.setFlag,
}));

import { PortalAccessPanel } from '../owner/PortalAccessPanel';

const CONTACT = '10000000-0000-4000-8000-0000000000c1';
const account = (over: Record<string, unknown>) => ({
  id: 'acc-1',
  user_id: null,
  contact_id: CONTACT,
  role: 'primary',
  status: 'invited',
  invited_email: 'ada@example.com',
  invited_at: '2026-05-01T00:00:00Z',
  activated_at: null,
  last_login_at: null,
  login_count: 0,
  ...over,
});
const emails = [
  { id: 'e-1', kind: 'primary', email: 'ada@example.com', is_default: true },
  { id: 'e-2', kind: 'spouse', email: 'charles@example.com', is_default: true },
];

/** The address list, once the panel has loaded. */
const addresses = () => screen.findByRole('list', { name: 'Portal addresses' });

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortalAccessPanel contactId={CONTACT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.view = { accounts: [account({ status: 'active', user_id: 'u-1', last_login_at: '2026-05-01T00:00:00Z' })], emails, config: { hide_documents: false, hide_messages: false } };
});

describe('PortalAccessPanel', () => {
  it('offers Deactivate for the active address and Invite for the spouse, never Invite twice', async () => {
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Portal addresses' });
    expect(within(list).getByRole('button', { name: 'Turn off portal access for ada@example.com' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Invite charles@example.com' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Invite ada@example.com' })).toBeNull();
  });

  it('Resend for an invited account and Re-invite for a deactivated one act on that account', async () => {
    h.view = {
      accounts: [account({ id: 'acc-1' }), account({ id: 'acc-2', status: 'deactivated', invited_email: 'charles@example.com', user_id: 'u-2' })],
      emails,
      config: { hide_documents: false, hide_messages: false },
    };
    h.resendInvite.mockResolvedValue({ success: true, inviteUrl: 'https://example.com/invite#token=x', emailSent: true, delivery: 'sent' });
    renderPanel();
    const list = await addresses();
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Invite charles@example.com again' }));
    });
    expect(h.resendInvite).toHaveBeenCalledWith('acc-2');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend the invitation to ada@example.com' }));
    });
    expect(h.resendInvite).toHaveBeenLastCalledWith('acc-1');
  });

  it('shows the link to copy when the email did not go out', async () => {
    h.sendInvite.mockResolvedValue({ success: true, inviteUrl: 'https://example.com/invite#token=abc', emailSent: false, delivery: 'failed' });
    renderPanel();
    const list = await addresses();
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Invite charles@example.com' }));
    });
    expect(h.sendInvite).toHaveBeenCalledWith(CONTACT, 'charles@example.com');
    expect(await screen.findByText('The email did not go out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invitation link: https://example.com/invite#token=abc' })).toBeInTheDocument();
  });

  it('holds the switches while one write is in flight', async () => {
    let finish: () => void = () => {};
    h.setFlag.mockReturnValue(new Promise<void>((r) => (finish = r)));
    renderPanel();
    await addresses();
    fireEvent.click(screen.getByRole('switch', { name: 'Hide Documents' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Hide Messages' })).toBeDisabled());
    expect(h.setFlag).toHaveBeenCalledWith(CONTACT, 'hide_documents', true);
    expect(screen.getByRole('switch', { name: 'Hide Documents' })).toHaveAttribute('aria-checked', 'true');
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Hide Messages' })).not.toBeDisabled());
  });

  it('starts View as client only after the owner confirms', async () => {
    renderPanel();
    await addresses();
    fireEvent.click(screen.getByRole('button', { name: 'View as client' }));
    expect(h.startViewAsClient).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/read-only/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'View as client' }));
    });
    expect(h.startViewAsClient).toHaveBeenCalledWith(CONTACT);
  });
});
