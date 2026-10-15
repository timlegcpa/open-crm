// The portal's signing exchange: refused during View as client before anything is asked,
// and each answer of the exchange on its own screen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EdgeError } from '@/lib/edgeCore';

const state = vi.hoisted(() => ({
  auth: { isViewAsClientSession: false, clientContactId: 'contact-ada' as string | null },
  exchange: vi.fn(),
  tasks: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('../api', () => ({
  exchangePortalSignerToken: (...a: unknown[]) => state.exchange(...a),
  listMySignatureTasks: (...a: unknown[]) => state.tasks(...a),
}));
vi.mock('../public/signer/SignerFlow', () => ({
  SignerFlow: ({ initialToken }: { initialToken?: string }) => <p>signer flow with {initialToken}</p>,
}));

import { PortalSignPage, SignatureNeededCard } from '../portal';

const SIGNER = '0b6f1a52-6a43-4d55-9f3e-2b8f9c1d7e01';

function renderAt(url: string, ui = <PortalSignPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.auth = { isViewAsClientSession: false, clientContactId: 'contact-ada' };
  state.exchange.mockReset();
  state.tasks.mockReset();
});

describe('PortalSignPage', () => {
  it('during View as client says signing is off and never asks for a token', async () => {
    state.auth.isViewAsClientSession = true;
    renderAt(`/portal/sign?signer=${SIGNER}`);
    expect(await screen.findByText('Signing is off while viewing as client')).toBeInTheDocument();
    expect(state.exchange).not.toHaveBeenCalled();
  });

  it('the server refusing an impersonated session reads the same', async () => {
    state.exchange.mockRejectedValue(new EdgeError('forbidden', { status: 403, code: 'impersonation_read_only' }));
    renderAt(`/portal/sign?signer=${SIGNER}`);
    expect(await screen.findByText('Signing is off while viewing as client')).toBeInTheDocument();
  });

  it('any other refusal means the request is someone else’s', async () => {
    state.exchange.mockRejectedValue(new EdgeError('forbidden', { status: 403 }));
    renderAt(`/portal/sign?signer=${SIGNER}`);
    expect(await screen.findByText('This request is for someone else')).toBeInTheDocument();
  });

  it('a fresh token opens the signer flow, never stored', async () => {
    state.exchange.mockResolvedValue({ state: 'ok', token: 'fresh-token-0123456789' });
    renderAt(`/portal/sign?signer=${SIGNER}`);
    expect(await screen.findByText('signer flow with fresh-token-0123456789')).toBeInTheDocument();
    expect(state.exchange).toHaveBeenCalledWith(SIGNER);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('end states have their own screens', async () => {
    state.exchange.mockResolvedValue({ state: 'expired' });
    renderAt(`/portal/sign?signer=${SIGNER}`);
    expect(await screen.findByText('This signing link has expired')).toBeInTheDocument();
  });

  it('a malformed signer id is not sent', async () => {
    renderAt('/portal/sign?signer=../../etc');
    expect(await screen.findByText('This document could not be opened')).toBeInTheDocument();
    expect(state.exchange).not.toHaveBeenCalled();
  });

  it('with no signer id, lists what is waiting, linking only to signer ids', async () => {
    state.tasks.mockResolvedValue([
      { id: 't1', title: 'Acme engagement letter', link: `/portal/sign?signer=${SIGNER}`, created_at: '2026-10-01T00:00:00Z' },
      { id: 't2', title: 'Odd link', link: 'https://elsewhere.example.com/x', created_at: '2026-10-02T00:00:00Z' },
      { id: 't3', title: 'Foreign link', link: `https://elsewhere.example.com/sign?signer=${SIGNER}`, created_at: '2026-10-03T00:00:00Z' },
    ]);
    renderAt('/portal/sign');
    const links = await screen.findAllByRole('link', { name: 'Review and sign' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/portal/sign?signer=${SIGNER}`, '/portal/sign', '/portal/sign']);
  });
});

describe('SignatureNeededCard', () => {
  it('says so when nothing is waiting, rather than leaving an empty box', async () => {
    state.tasks.mockResolvedValue([]);
    renderAt('/portal', <SignatureNeededCard />);
    expect(await screen.findByText('Nothing is waiting for your signature.')).toBeInTheDocument();
  });
});
