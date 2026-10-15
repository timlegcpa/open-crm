// The auth provider's portal half: View as client (stash, swap, end, restore), the client's
// session events, the inactivity expiry and the first sign-in after an invitation. A small
// purpose-built Supabase stand-in: the shared fake has no setSession and no function answers
// per name.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

interface TestSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; factors?: unknown[] };
}

const h = vi.hoisted(() => ({
  session: null as TestSession | null,
  listeners: [] as Array<(event: string, s: TestSession | null) => void>,
  invoke: null as unknown as (name: string, body: unknown, timeout: number | undefined) => Promise<{ data: unknown; error: unknown }>,
  invokeCalls: [] as Array<{ name: string; body: unknown; timeout: number | undefined }>,
  signOuts: [] as unknown[],
  setSessionError: null as unknown,
  sessionsByToken: {} as Record<string, TestSession>,
  viewRpc: false,
}));

vi.mock('@/lib/supabase', () => {
  const emit = (event: string) => h.listeners.forEach((cb) => cb(event, h.session));
  const client = {
    auth: {
      getSession: async () => ({ data: { session: h.session } }),
      onAuthStateChange: (cb: (event: string, s: TestSession | null) => void) => {
        h.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      setSession: async ({ access_token }: { access_token: string }) => {
        if (h.setSessionError) return { data: { session: null }, error: h.setSessionError };
        h.session = h.sessionsByToken[access_token];
        emit('SIGNED_IN');
        return { data: { session: h.session }, error: null };
      },
      signOut: async (options: unknown) => {
        h.signOuts.push(options);
        h.session = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' }, error: null }) },
    },
    rpc: async (name: string) => {
      const id = h.session?.user.id;
      if (name === 'is_owner') return { data: id === 'owner-1', error: null };
      if (name === 'get_client_contact_id') return { data: id === 'client-1' ? CONTACT : null, error: null };
      if (name === 'is_view_as_client') return { data: id === 'client-1' && h.viewRpc, error: null };
      return { data: null, error: null };
    },
    from: () => ({ insert: async () => ({ error: null }) }),
    functions: {
      invoke: (name: string, options: { body: unknown; timeout?: number }) => {
        h.invokeCalls.push({ name, body: options.body, timeout: options.timeout });
        return h.invoke(name, options.body, options.timeout);
      },
    },
  };
  const CONTACT = '10000000-0000-4000-8000-0000000000c1';
  return { supabaseConfigured: true, getSupabase: () => client };
});

import { AuthProvider, PORTAL_LOGIN_PENDING_KEY, SESSION_EXPIRED_KEY, useAuth, ViewNotEndedError } from '@/lib/auth';
import { INVITE_LOGIN_PENDING_KEY } from '../public/InvitePage';

const CONTACT = '10000000-0000-4000-8000-0000000000c1';
const ROW = '20000000-0000-4000-8000-0000000000a1';
const OWNER: TestSession = { access_token: 'owner-at', refresh_token: 'owner-rt', user: { id: 'owner-1', email: 'owner@example.com' } };
const CLIENT: TestSession = { access_token: 'client-at', refresh_token: 'client-rt', user: { id: 'client-1', email: 'ada@example.com' } };

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return null;
}

async function mount() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(auth.isLoadingAuth).toBe(false));
}

const ok = (data: unknown) => Promise.resolve({ data, error: null });
const started = { session_id: ROW, access_token: CLIENT.access_token, refresh_token: CLIENT.refresh_token, expires_at: 1, contact_id: CONTACT, contact_name: 'Ada Lovelace', client_user_id: 'client-1' };

beforeEach(() => {
  h.session = null;
  h.listeners = [];
  h.invokeCalls = [];
  h.signOuts = [];
  h.setSessionError = null;
  h.sessionsByToken = { [OWNER.access_token]: OWNER, [CLIENT.access_token]: CLIENT };
  h.invoke = () => ok({ success: true });
  window.sessionStorage.clear();
  window.localStorage.clear();
  h.viewRpc = false;
});

describe('View as client', () => {
  it("stashes the owner's session before asking for the client's, then swaps", async () => {
    h.session = OWNER;
    let stashedFirst = false;
    h.invoke = (name) => {
      if (name === 'admin-impersonate') {
        stashedFirst = Object.keys(window.localStorage).some((k) => window.localStorage.getItem(k)?.includes('owner-rt'));
        return ok(started);
      }
      return ok({ success: true });
    };
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(() => auth.startViewAsClient(CONTACT));
    expect(stashedFirst).toBe(true);
    await waitFor(() => expect(auth.principal).toBe('client'));
    expect(auth.viewAsClient).toMatchObject({ sessionRowId: ROW, contactId: CONTACT, contactName: 'Ada Lovelace' });
  });

  it("Exit restores the owner's session, then closes the row with a time limit; nobody is signed out", async () => {
    h.session = OWNER;
    h.invoke = (name) => ok(name === 'admin-impersonate' ? started : { success: true });
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(() => auth.startViewAsClient(CONTACT));
    await waitFor(() => expect(auth.principal).toBe('client'));

    await act(() => auth.logout());
    await waitFor(() => expect(auth.principal).toBe('owner'));
    expect(h.session).toBe(OWNER);
    expect(auth.viewAsClient).toBeNull();
    expect(h.signOuts).toEqual([]);
    const end = h.invokeCalls.find((c) => c.name === 'admin-impersonate-end');
    expect(end).toMatchObject({ body: { session_id: ROW }, timeout: 8000 });
    expect(h.invokeCalls.map((c) => c.name)).not.toContain('log-portal-event');
    expect(Object.keys(window.localStorage)).toEqual([]);
  });

  it('an end the server refuses puts the view back on; a retry then ends it', async () => {
    h.session = OWNER;
    let endFails = true;
    h.invoke = (name) => {
      if (name === 'admin-impersonate') return ok(started);
      if (endFails) return Promise.resolve({ data: null, error: { message: 'revoke_failed' } });
      return ok({ success: true });
    };
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(() => auth.startViewAsClient(CONTACT));
    await waitFor(() => expect(auth.principal).toBe('client'));

    await act(async () => {
      await expect(auth.logout()).rejects.toBeInstanceOf(ViewNotEndedError);
    });
    await waitFor(() => expect(auth.principal).toBe('client'));
    expect(h.session).toBe(CLIENT);
    expect(auth.viewAsClient).toMatchObject({ sessionRowId: ROW });
    expect(h.signOuts).toEqual([]);

    endFails = false;
    await act(() => auth.logout());
    await waitFor(() => expect(auth.principal).toBe('owner'));
    expect(h.session).toBe(OWNER);
    expect(auth.viewAsClient).toBeNull();
  });

  it('a start that fails leaves the owner where they were, with nothing stashed', async () => {
    h.session = OWNER;
    h.invoke = (name) =>
      name === 'admin-impersonate' ? Promise.resolve({ data: null, error: { message: 'refused' } }) : ok({ success: true });
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(async () => {
      await expect(auth.startViewAsClient(CONTACT)).rejects.toBeTruthy();
    });
    expect(h.session).toBe(OWNER);
    expect(auth.viewAsClient).toBeNull();
    expect(Object.keys(window.localStorage)).toEqual([]);
  });

  it('a swap the browser refuses closes the row it opened', async () => {
    h.session = OWNER;
    h.invoke = (name) => ok(name === 'admin-impersonate' ? started : { success: true });
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    h.setSessionError = { message: 'bad session' };
    await act(async () => {
      await expect(auth.startViewAsClient(CONTACT)).rejects.toBeTruthy();
    });
    expect(h.invokeCalls.find((c) => c.name === 'admin-impersonate-end')).toMatchObject({ body: { session_id: ROW } });
    expect(auth.viewAsClient).toBeNull();
  });

  it('an inactivity expiry while viewing hands the owner back, with no expired notice', async () => {
    h.session = OWNER;
    h.invoke = (name) => ok(name === 'admin-impersonate' ? started : { success: true });
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(() => auth.startViewAsClient(CONTACT));
    await waitFor(() => expect(auth.principal).toBe('client'));
    await act(() => auth.expireSession());
    await waitFor(() => expect(auth.principal).toBe('owner'));
    expect(window.sessionStorage.getItem(SESSION_EXPIRED_KEY)).toBeNull();
    expect(h.signOuts).toEqual([]);
  });
});

describe('View as client across tabs (one browser session)', () => {
  /** What another tab sees: the shared storage already holds the view, the session is the client's. */
  function viewStartedElsewhere() {
    window.localStorage.setItem('open-crm:view-as-client:owner-session', JSON.stringify({ access_token: OWNER.access_token, refresh_token: OWNER.refresh_token }));
    window.localStorage.setItem('open-crm:view-as-client', JSON.stringify({
      sessionRowId: ROW, contactId: CONTACT, contactName: 'Ada Lovelace', startedAt: '2026-05-01T00:00:00Z', clientUserId: CLIENT.user.id,
    }));
    h.session = CLIENT;
  }

  it("a tab that never saw the start shows the view, and its Sign out gives the owner's session back", async () => {
    viewStartedElsewhere();
    await mount();
    await waitFor(() => expect(auth.principal).toBe('client'));
    expect(auth.isViewAsClientSession).toBe(true);
    await act(() => auth.logout());
    await waitFor(() => expect(auth.principal).toBe('owner'));
    expect(h.session).toBe(OWNER);
    expect(h.signOuts).toEqual([]);
    expect(h.invokeCalls.find((c) => c.name === 'admin-impersonate-end')).toMatchObject({ body: { session_id: ROW } });
  });

  it('follows a view another tab starts or ends', async () => {
    h.session = OWNER;
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    viewStartedElsewhere();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'open-crm:view-as-client' }));
    });
    expect(auth.viewAsClient).toMatchObject({ sessionRowId: ROW });
    window.localStorage.clear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'open-crm:view-as-client' }));
    });
    expect(auth.viewAsClient).toBeNull();
  });

  it('an Exit that finds the view already ended by another tab signs nobody out', async () => {
    h.session = OWNER;
    await mount();
    await waitFor(() => expect(auth.principal).toBe('owner'));
    await act(() => auth.endViewAsClient());
    expect(h.signOuts).toEqual([]);
    expect(h.session).toBe(OWNER);
  });

  it('the database alone can mark a session as a view: banner on, and Sign out stays local', async () => {
    h.session = CLIENT;
    h.viewRpc = true;
    await mount();
    await waitFor(() => expect(auth.isViewAsClientSession).toBe(true));
    expect(auth.viewAsClient).toBeNull();
    await act(() => auth.logout());
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
    expect(h.invokeCalls.map((c) => c.name)).not.toContain('log-portal-event');
  });
});

describe("a client's session", () => {
  it('signs out of this browser only, after recording the sign-out', async () => {
    h.session = CLIENT;
    await mount();
    await waitFor(() => expect(auth.principal).toBe('client'));
    await act(() => auth.logout());
    expect(h.invokeCalls.map((c) => [c.name, c.body])).toEqual([['log-portal-event', { action: 'logout' }]]);
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
  });

  it('an inactivity expiry is recorded, explained on the sign-in screen, and local', async () => {
    h.session = CLIENT;
    await mount();
    await waitFor(() => expect(auth.principal).toBe('client'));
    await act(() => auth.expireSession());
    expect(h.invokeCalls.map((c) => c.body)).toEqual([{ action: 'session_expired' }]);
    expect(window.sessionStorage.getItem(SESSION_EXPIRED_KEY)).toBe('1');
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
  });

  it('records the first sign-in after an invitation, once', async () => {
    expect(INVITE_LOGIN_PENDING_KEY).toBe(PORTAL_LOGIN_PENDING_KEY);
    window.sessionStorage.setItem(INVITE_LOGIN_PENDING_KEY, '1');
    h.session = CLIENT;
    await mount();
    await waitFor(() => expect(h.invokeCalls.map((c) => c.body)).toEqual([{ action: 'login' }]));
    expect(window.sessionStorage.getItem(PORTAL_LOGIN_PENDING_KEY)).toBeNull();
  });

  it('a session already open when the app loads is not a new sign-in', async () => {
    h.session = CLIENT;
    await mount();
    await waitFor(() => expect(auth.principal).toBe('client'));
    expect(h.invokeCalls).toEqual([]);
  });
});
