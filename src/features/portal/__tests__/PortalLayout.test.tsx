// The portal frame: the hidden-section gate (a typed address cannot open what the owner
// hid, nested pages included), nothing rendered before the switches are known, the
// sections filtered from the navigation, and Sign out while viewing as client ending the view.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FileText, House, MessageSquare } from 'lucide-react';

const h = vi.hoisted(() => ({
  contact: null as null | Promise<unknown>,
  viewAsClient: null as null | { sessionRowId: string; contactId: string; contactName: string; startedAt: string; clientUserId: string },
  endViewAsClient: vi.fn(async () => {}),
  expireSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', () => ({
  ViewNotEndedError: class ViewNotEndedError extends Error {},
  useAuth: () => ({
    viewAsClient: h.viewAsClient,
    isViewAsClientSession: h.viewAsClient !== null,
    expireSession: h.expireSession,
    endViewAsClient: h.endViewAsClient,
  }),
}));
vi.mock('../api', () => ({
  portalKeys: { myContact: () => ['portal', 'my-contact'] },
  getMyContact: () => h.contact,
}));
vi.mock('@/features/registry', () => ({
  portalTabs: [
    { label: 'Home', icon: House, path: '/portal', order: 10, end: true },
    { label: 'Documents', icon: FileText, path: '/portal/documents', order: 20 },
    { label: 'Messages', icon: MessageSquare, path: '/portal/messages', order: 30 },
  ],
}));

import { PortalLayout } from '../PortalLayout';

const contact = (config: Record<string, unknown>) => Promise.resolve({ id: 'c-1', portal_sidebar_config: config });

function renderAt(path: string, onSignOut = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/portal" element={<PortalLayout orgName="Acme LLC" email="ada@example.com" onSignOut={onSignOut} />}>
            <Route index element={<p>Home page</p>} />
            <Route path="documents/*" element={<p>Documents page</p>} />
            <Route path="messages/*" element={<p>Messages page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSignOut;
}

beforeEach(() => {
  h.viewAsClient = null;
  h.endViewAsClient.mockClear();
  h.contact = contact({});
});

describe('PortalLayout', () => {
  it('opens a section that is not hidden', async () => {
    renderAt('/portal/documents/abc');
    expect(await screen.findByText('Documents page')).toBeInTheDocument();
  });

  it('sends a hidden section, and any page under it, to Home', async () => {
    h.contact = contact({ hide_documents: true });
    renderAt('/portal/documents/abc');
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Documents page')).toBeNull();
  });

  it('hides Messages the same way, and leaves the hidden sections out of the navigation', async () => {
    h.contact = contact({ hide_messages: true });
    renderAt('/portal/messages');
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Portal sections' });
    expect(rail.textContent).toContain('Documents');
    expect(rail.textContent).not.toContain('Messages');
  });

  it('renders no page until the switches are known', async () => {
    let resolve: (v: unknown) => void = () => {};
    h.contact = new Promise((r) => {
      resolve = r;
    });
    renderAt('/portal/documents');
    expect(screen.queryByText('Documents page')).toBeNull();
    await act(async () => resolve({ id: 'c-1', portal_sidebar_config: { hide_documents: true } }));
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Documents page')).toBeNull();
  });

  it('Sign out while viewing as client ends the view instead of signing out', async () => {
    h.viewAsClient = { sessionRowId: 'r-1', contactId: 'c-1', contactName: 'Ada Lovelace', startedAt: '2026-05-01T00:00:00Z', clientUserId: 'u-1' };
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, replace } as Location);
    const onSignOut = renderAt('/portal');
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    });
    expect(h.endViewAsClient).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/contacts/c-1');
    vi.restoreAllMocks();
  });

  it('an Exit that could not end the view keeps the owner on the page, with the banner', async () => {
    h.viewAsClient = { sessionRowId: 'r-1', contactId: 'c-1', contactName: 'Ada Lovelace', startedAt: '2026-05-01T00:00:00Z', clientUserId: 'u-1' };
    h.endViewAsClient.mockRejectedValueOnce(new Error('View as client could not be ended.'));
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, replace } as Location);
    renderAt('/portal');
    const exit = await screen.findByRole('button', { name: 'Exit' });
    await act(async () => {
      fireEvent.click(exit);
    });
    expect(h.endViewAsClient).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Exit' })).not.toBeDisabled();
    vi.restoreAllMocks();
  });
});
