import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Factor = { id: string; status: 'verified' | 'unverified' };
type FakeSession = { user: { id: string; email: string; factors?: Factor[] } };

const fake = vi.hoisted(() => {
  const state = {
    configured: true,
    session: null as FakeSession | null,
    aal: 'aal1' as 'aal1' | 'aal2',
    isOwner: { data: true as unknown, error: null as unknown },
    signInResult: null as FakeSession | null,
    signInError: null as unknown,
    isOwnerPending: false,
    verifyError: null as unknown,
    listeners: [] as Array<(event: string, s: FakeSession | null) => void>,
    audit: [] as Array<{ action: string; user_id: string }>,
    auditError: null as unknown,
    rpcCalls: [] as string[],
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      onAuthStateChange: (cb: (event: string, s: FakeSession | null) => void) => {
        state.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async () => {
        if (state.signInError) return { data: { session: null }, error: state.signInError };
        if (!state.signInResult) return { data: { session: null }, error: { message: 'Invalid login credentials' } };
        state.session = state.signInResult;
        state.listeners.forEach((cb) => cb('SIGNED_IN', state.session));
        return { data: { session: state.session, user: state.session.user }, error: null };
      },
      signOut: async () => {
        state.session = null;
        state.listeners.forEach((cb) => cb('SIGNED_OUT', null));
        return { error: null };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }),
        listFactors: async () => ({ data: { totp: state.session?.user.factors ?? [] } }),
        challenge: async () => ({ data: { id: 'ch1' }, error: null }),
        verify: async () => {
          if (state.verifyError) return { error: state.verifyError };
          state.aal = 'aal2';
          return { error: null };
        },
      },
    },
    rpc: async (name: string) => {
      state.rpcCalls.push(name);
      if (name === 'get_org_branding') return { data: { display_name: 'Example Firm' }, error: null };
      if (name === 'is_owner') return state.isOwnerPending ? new Promise(() => {}) : state.isOwner;
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => ({
      insert: async (row: { action: string; user_id: string }) => {
        if (state.auditError) return { error: state.auditError };
        if (table === 'audit_logs') state.audit.push(row);
        return { error: null };
      },
    }),
  };
  return { state, client };
});

vi.mock('@/lib/supabase', () => ({
  get supabaseConfigured() {
    return fake.state.configured;
  },
  getSupabase: () => fake.client,
}));

import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { App } from '@/App';

const OWNER: FakeSession = { user: { id: 'owner-1', email: 'owner@example.com' } };
const OWNER_WITH_APP: FakeSession = { user: { ...OWNER.user, factors: [{ id: 'f1', status: 'verified' }] } };

function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Good-pass-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  Object.assign(fake.state, {
    configured: true,
    session: null,
    aal: 'aal1',
    isOwner: { data: true, error: null },
    signInResult: null,
    signInError: null,
    isOwnerPending: false,
    verifyError: null,
    listeners: [],
    audit: [],
    auditError: null,
    rpcCalls: [],
  });
});

describe('owner sign-in', () => {
  it('tells an unconfigured clone to run the bootstrap', () => {
    fake.state.configured = false;
    render(<App />);
    expect(screen.getByText(/dev:bootstrap/)).toBeInTheDocument();
  });

  it('shows one generic message for a failed sign-in', async () => {
    render(<App />);
    await screen.findByText('Example Firm');
    signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('says the server is unreachable, not that the password is wrong, when Auth never answers', async () => {
    fake.state.signInError = new AuthRetryableFetchError('Failed to fetch', 0);
    render(<App />);
    await screen.findByLabelText('Email');
    signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('asks the database again after signing out and back in as the same user', async () => {
    fake.state.session = OWNER;
    fake.state.signInResult = OWNER;
    render(<App />);
    await screen.findByText('Signed in as owner@example.com.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await screen.findByLabelText('Email');
    // The database has not answered yet: the old "owner" answer must not stand in for it.
    fake.state.isOwnerPending = true;
    signIn();
    expect(await screen.findByText('Checking your account...')).toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('lets the owner in with a password when no authenticator is set up, and audits it once', async () => {
    fake.state.signInResult = OWNER;
    render(<App />);
    await screen.findByLabelText('Email');
    signIn();
    expect(await screen.findByText('Signed in as owner@example.com.')).toBeInTheDocument();
    await waitFor(() => expect(fake.state.audit).toEqual([expect.objectContaining({ action: 'owner_login', user_id: 'owner-1' })]));
  });

  it('asks for the code, renders nothing protected, and audits only after the code', async () => {
    fake.state.signInResult = OWNER_WITH_APP;
    render(<App />);
    await screen.findByLabelText('Email');
    signIn();
    expect(await screen.findByText('Authenticator code')).toBeInTheDocument();
    expect(fake.state.rpcCalls).not.toContain('is_owner');
    expect(fake.state.audit).toEqual([]);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Signed in as owner@example.com.')).toBeInTheDocument();
    await waitFor(() => expect(fake.state.audit.map((a) => a.action)).toEqual(['owner_login']));
  });

  it('keeps a wrong code on the challenge', async () => {
    fake.state.signInResult = OWNER_WITH_APP;
    fake.state.verifyError = { message: 'Invalid TOTP code entered' };
    render(<App />);
    await screen.findByLabelText('Email');
    signIn();
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work');
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('still lets the owner in when the audit write is refused, and says so in the console', async () => {
    fake.state.signInResult = OWNER;
    fake.state.auditError = { message: 'new row violates row-level security policy' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<App />);
    await screen.findByLabelText('Email');
    signIn();
    expect(await screen.findByText('Signed in as owner@example.com.')).toBeInTheDocument();
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner_login was not written')));
    warn.mockRestore();
  });

  it('turns away an account the database says is not the owner', async () => {
    fake.state.session = OWNER;
    fake.state.isOwner = { data: false, error: null };
    render(<App />);
    expect(await screen.findByText('This account is not the owner of this CRM.')).toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('fails closed when the owner check errors', async () => {
    fake.state.session = OWNER;
    fake.state.isOwner = { data: null, error: { message: 'boom' } };
    render(<App />);
    expect(await screen.findByText(/Could not confirm your account/)).toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('does not audit a page load of an existing session, and audits the sign-out', async () => {
    fake.state.session = OWNER;
    render(<App />);
    await screen.findByText('Signed in as owner@example.com.');
    expect(fake.state.audit).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    expect(fake.state.audit.map((a) => a.action)).toEqual(['owner_logout']);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });
});
