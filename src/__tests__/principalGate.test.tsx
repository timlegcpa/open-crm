import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The shared fake, with the client RPC answerable per test (the shared one answers null).
const rpc = vi.hoisted(() => ({ answers: {} as Record<string, { data: unknown; error: unknown }> }));

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/__tests__/fakeSupabase');
  const client = {
    ...fake.client,
    rpc: async (name: string, args?: unknown) => {
      if (!(name in rpc.answers)) return fake.client.rpc(name, args);
      fake.state.rpcCalls.push({ name, args });
      return rpc.answers[name];
    },
  };
  return { supabaseConfigured: true, getSupabase: () => client };
});

import { fake, type FakeSession } from '@/__tests__/fakeSupabase';
import { App } from '@/App';
import { sessionGeneration } from '@/features/messages/keySession';
import { AuthProvider, useAuth } from '@/lib/auth';
import { queryClient } from '@/lib/queryClient';

const OWNER: FakeSession = { user: { id: 'owner-1', email: 'owner@example.com' } };
const CLIENT: FakeSession = { user: { id: 'client-1', email: 'client@example.com' } };
const CONTACT_ID = '10000000-0000-4000-8000-0000000000c1';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

/** What supabase-js does when another tab signs in: a new session arrives on the auth listener. */
async function authEvent(event: 'SIGNED_IN' | 'SIGNED_OUT', session: FakeSession | null) {
  fake.state.session = session;
  await act(async () => {
    fake.state.listeners.forEach((listener) => listener(event, session));
  });
}

function asClient() {
  fake.state.isOwner = { data: false, error: null };
  rpc.answers.get_client_contact_id = { data: CONTACT_ID, error: null };
}

const rpcNames = () => fake.state.rpcCalls.map((c) => c.name);

// Load every lazy page these tests reach before the first one runs. A cold transform of a
// page chunk under a busy machine outlasted findByText's wait; once loaded, a lazy page
// resolves in a tick.
beforeAll(async () => {
  await Promise.all([
    import('@/AuthenticatedApp'),
    import('@/OwnerApp'),
    import('@/PortalApp'),
    import('@/pages/contacts/ContactsList'),
    import('@/features/portal/PortalLayout'),
    import('@/features/portal/pages/HomePage'),
    import('@/features/portal/pages/ProfilePage'),
  ]);
}, 60_000);

beforeEach(() => {
  fake.reset();
  rpc.answers = {};
  fake.state.tables.contact_statuses = [{ key: 'new_lead', label: 'New lead', colour: null, sort_order: 10 }];
  fake.state.tables.lead_sources = [{ key: 'other', label: 'Other', colour: null, sort_order: 10, is_active: true }];
  fake.state.tables.contacts = [
    {
      id: '10000000-0000-4000-8000-00000000000a',
      created_at: '2026-03-01T15:00:00Z',
      updated_at: '2026-03-01T15:00:00Z',
      first_name: 'Ada',
      last_name: 'Example',
      full_name: 'Ada Example',
      status: 'new_lead',
      source: 'other',
    },
  ];
});

describe('the signed-in gate', () => {
  it('sends the owner to the owner app and never asks the client question', async () => {
    fake.state.session = OWNER;
    renderAt('/contacts');
    expect(await screen.findByText('Signed in as owner@example.com.')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Portal' })).toBeNull();
    expect(rpcNames()).toContain('is_owner');
    expect(rpcNames()).not.toContain('get_client_contact_id');
  });

  it('sends a client to the portal at /portal, whatever address they opened, and runs no owner query', async () => {
    fake.state.session = CLIENT;
    asClient();
    renderAt('/contacts');
    expect(await screen.findByRole('navigation', { name: 'Portal' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/portal'));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(rpcNames().filter((n) => n === 'is_owner' || n === 'get_client_contact_id')).toEqual(['is_owner', 'get_client_contact_id']);
    expect(fake.calls('contacts')).toEqual([]);
  });

  it('shows an account that is neither the no-access screen, with a way out', async () => {
    fake.state.session = CLIENT;
    fake.state.isOwner = { data: false, error: null };
    renderAt('/contacts');
    expect(await screen.findByText('This account is not the owner of this CRM.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('fails closed when the client check errors', async () => {
    fake.state.session = CLIENT;
    fake.state.isOwner = { data: false, error: null };
    rpc.answers.get_client_contact_id = { data: null, error: { message: 'permission denied for function' } };
    renderAt('/portal');
    expect(await screen.findByText(/Could not confirm your account/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it("exposes the client's contact id, and none for the owner", async () => {
    function Probe() {
      const { principal, clientContactId } = useAuth();
      return <p>{`${principal}:${clientContactId ?? 'none'}`}</p>;
    }
    fake.state.session = CLIENT;
    asClient();
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText(`client:${CONTACT_ID}`)).toBeInTheDocument();
    unmount();

    fake.reset();
    rpc.answers = {};
    fake.state.session = OWNER;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText('owner:none')).toBeInTheDocument();
  });

  it('clears the cache when the signed-in principal changes, even without a sign-out', async () => {
    fake.state.session = OWNER;
    renderAt('/contacts');
    await screen.findByText('Signed in as owner@example.com.');
    queryClient.setQueryData(['probe'], 'cached for the owner');

    asClient();
    await authEvent('SIGNED_IN', CLIENT);
    expect(await screen.findByRole('navigation', { name: 'Portal' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  });

  it('locks the messages key when the signed-in principal changes', async () => {
    fake.state.session = OWNER;
    renderAt('/contacts');
    await screen.findByText('Signed in as owner@example.com.');
    const before = sessionGeneration();

    asClient();
    await authEvent('SIGNED_IN', CLIENT);
    expect(await screen.findByRole('navigation', { name: 'Portal' })).toBeInTheDocument();
    expect(sessionGeneration()).toBeGreaterThan(before);
  });

  it("never wipes a principal's first queries with the clear meant for the one before", async () => {
    fake.state.session = OWNER;
    // The All tab: the default Clients tab does not list a lead.
    renderAt('/contacts?tab=all');
    expect(await screen.findByText('Ada Example')).toBeInTheDocument();

    await authEvent('SIGNED_OUT', null);
    await screen.findByLabelText('Email');
    const before = fake.calls('contacts', 'select').length;

    // Back in as the owner: every chunk is loaded now, so the list renders in the same
    // pass as the gate opens. Its query must survive, and run once.
    await authEvent('SIGNED_IN', OWNER);
    expect(await screen.findByText('Ada Example')).toBeInTheDocument();
    await act(async () => {});
    expect(fake.calls('contacts', 'select').length - before).toBe(1);
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
  });
});
