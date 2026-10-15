import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const client = vi.hoisted(() => ({
  rpc: vi.fn(),
  functions: { invoke: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabaseConfigured: true, getSupabase: () => client }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { functionsHttpError } from '@/__tests__/fakeSupabase';
import { ConnectorSettings, ConnectPage } from '../pages';
import { connectorUrl, safeRedirect } from '../api';

const REQUEST = { request_id: 'req-1', client_name: 'Example assistant', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'mcp:crm' };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback?code=abc&state=st';
const GRANT = '10000000-0000-4000-8000-000000000001';

function renderAt(path: string, ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  client.rpc.mockReset();
  client.functions.invoke.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

/** The consent function: `read` answers the request, `decide` answers `decision`. */
function consentAnswers(decision: { data: unknown; error: unknown } = { data: { redirect_to: CALLBACK }, error: null }) {
  client.functions.invoke.mockImplementation(async (_name: string, opts: { body: { action: string } }) =>
    opts.body.action === 'read' ? { data: REQUEST, error: null } : decision,
  );
}

describe('ConnectPage', () => {
  it('says so when the link has no request, calling nothing', async () => {
    renderAt('/connect', <ConnectPage />);
    expect(await screen.findByText('No connection request')).toBeInTheDocument();
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });

  it('shows who is asking and where it returns, then follows the server’s answer on Approve', async () => {
    consentAnswers();
    renderAt('/connect?request=req-1', <ConnectPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Connect an assistant' })).toBeInTheDocument();
    expect(screen.getByText('Example assistant')).toBeInTheDocument();
    expect(screen.getByText('claude.ai')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(CALLBACK));
    expect(client.functions.invoke).toHaveBeenLastCalledWith('mcp-oauth', expect.objectContaining({ body: { action: 'decide', request_id: 'req-1', approve: true } }));
  });

  it('Deny sends approve false and follows the answer', async () => {
    consentAnswers({ data: { redirect_to: 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=st' }, error: null });
    renderAt('/connect?request=req-1', <ConnectPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(client.functions.invoke).toHaveBeenLastCalledWith('mcp-oauth', expect.objectContaining({ body: { action: 'decide', request_id: 'req-1', approve: false } }));
  });

  it('never assigns an address that is not https or loopback, even if the server said so', async () => {
    consentAnswers({ data: { redirect_to: 'javascript:alert(1)' }, error: null });
    renderAt('/connect?request=req-1', <ConnectPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
  });

  it('a failed decision is a toast and an inline error, and the page stays', async () => {
    consentAnswers({ data: null, error: functionsHttpError(500, { error: 'Something went wrong.', code: 'internal' }) });
    renderAt('/connect?request=req-1', <ConnectPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a sign-in without a second factor explains what to do and links to Security settings', async () => {
    client.functions.invoke.mockResolvedValue({
      data: null,
      error: functionsHttpError(403, { error: 'Approving a connection needs a two-factor sign-in.', code: 'mfa_required' }),
    });
    renderAt('/connect?request=req-1', <ConnectPage />);
    expect(await screen.findByText('Two-factor sign-in needed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Security settings' })).toHaveAttribute('href', '/settings/security');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('inside another page it refuses outright: no request is read and nothing can be approved', async () => {
    consentAnswers();
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    try {
      renderAt('/connect?request=req-1', <ConnectPage />);
      expect(await screen.findByText('Open this page in its own window')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(client.functions.invoke).not.toHaveBeenCalled();
    } finally {
      top.mockRestore();
    }
  });

  it('a parent page that cannot be read counts as framed', async () => {
    const top = vi.spyOn(window, 'top', 'get').mockImplementation(() => {
      throw new DOMException('Blocked a frame', 'SecurityError');
    });
    try {
      renderAt('/connect?request=req-1', <ConnectPage />);
      expect(await screen.findByText('Open this page in its own window')).toBeInTheDocument();
    } finally {
      top.mockRestore();
    }
  });

  it('warns plainly when the app returns to this computer, and says nothing for a provider callback', async () => {
    client.functions.invoke.mockResolvedValue({ data: { ...REQUEST, redirect_uri: 'http://127.0.0.1:3334/callback' }, error: null });
    const { unmount } = renderAt('/connect?request=req-1', <ConnectPage />);
    expect(await screen.findByText('This app returns to this computer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    unmount();
    consentAnswers();
    renderAt('/connect?request=req-2', <ConnectPage />);
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByText('This app returns to this computer')).toBeNull();
  });

  it('an expired request says so', async () => {
    client.functions.invoke.mockResolvedValue({ data: null, error: functionsHttpError(404, { error: 'This connection request was not found or has expired.', code: 'not_found' }) });
    renderAt('/connect?request=old', <ConnectPage />);
    expect(await screen.findByText(/has expired or was already answered/)).toBeInTheDocument();
  });
});

describe('ConnectorSettings', () => {
  const grant = { id: GRANT, client_name: 'Example assistant', created_at: '2026-10-01T12:00:00Z', last_used_at: null, expires_at: '2026-10-31T12:00:00Z' };

  it('shows the connector address to copy, and an empty list', async () => {
    client.rpc.mockResolvedValue({ data: [], error: null });
    renderAt('/settings/connector', <ConnectorSettings />);
    expect(await screen.findByText('No assistant is connected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Copy connector address: ${connectorUrl()}` })).toBeInTheDocument();
    expect(connectorUrl()).toMatch(/\/functions\/v1\/mcp-crm$/);
  });

  it('lists a live connection and disconnects it after confirmation', async () => {
    client.rpc.mockImplementation(async (name: string) =>
      name === 'mcp_list_grants' ? { data: [grant], error: null } : { data: true, error: null },
    );
    renderAt('/settings/connector', <ConnectorSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Example assistant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('mcp_revoke_grant', { p_grant_id: GRANT }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Example assistant is disconnected.'));
    await waitFor(() => expect(client.rpc.mock.calls.filter(([n]) => n === 'mcp_list_grants').length).toBe(2));
  });

  it('a failed disconnect is an error toast, never a success', async () => {
    client.rpc.mockImplementation(async (name: string) =>
      name === 'mcp_list_grants' ? { data: [grant], error: null } : { data: null, error: { message: 'mcp_revoke_grant: owner only' } },
    );
    renderAt('/settings/connector', <ConnectorSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Example assistant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses a malformed answer rather than rendering it', async () => {
    client.rpc.mockResolvedValue({ data: [{ id: 'not-a-uuid' }], error: null });
    renderAt('/settings/connector', <ConnectorSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load connections');
  });
});

describe('safeRedirect', () => {
  it('allows https and loopback http only', () => {
    expect(safeRedirect(CALLBACK)).toBe(true);
    expect(safeRedirect('http://localhost:3334/cb')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://claude.ai/cb', 'data:text/html,x', '/relative', 'nope']) {
      expect([bad, safeRedirect(bad)]).toEqual([bad, false]);
    }
  });
});
