import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase', async () => (await import('./fakeClient')).supabaseModule);
const auth = vi.hoisted(() => ({ userId: 'owner-1' as string | null }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: auth.userId ? { user: { id: auth.userId } } : null }) }));
// The unlock work itself, held open by each test.
const keys = vi.hoisted(() => ({
  getOwnerKey: vi.fn(async () => ({ id: 'k', public_key: '{}', encrypted_private_key: 'w', key_salt: 's', key_iv: 'i' })),
  unlockOwnerKey: vi.fn(),
}));
vi.mock('../ownerKey', () => keys);

import { fake } from './fakeClient';
import {
  holdSessionKey,
  lockEncryptionSession,
  sessionGeneration,
  sessionKeyFor,
  useEncryptionSession,
  type EncryptionSession,
} from '../keySession';

const KEY = { type: 'private' } as unknown as CryptoKey;
/** Every state any Probe rendered, in order. */
const seen: string[] = [];
/** The latest hook value from the inbox probe, to call unlock and holdAfter. */
let hook: EncryptionSession;

function Probe({ name }: { name: string }) {
  const { privateKey, lock } = useEncryptionSession();
  const session = useEncryptionSession();
  if (name === 'inbox') hook = session;
  seen.push(privateKey ? 'unlocked' : 'locked');
  return (
    <div>
      <span>{`${name}: ${privateKey ? 'unlocked' : 'locked'}`}</span>
      <button type="button" onClick={lock}>{`lock ${name}`}</button>
    </div>
  );
}

function renderTwo(): { rerender: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const tree = () => wrap(<><Probe name="inbox" /><Probe name="tab" /></>);
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

beforeEach(() => {
  fake.reset();
  auth.userId = 'owner-1';
  fake.emitAuth('SIGNED_IN', 'owner-1');
  lockEncryptionSession();
  seen.length = 0;
});

describe('the unlocked key', () => {
  it('locks in every mounted screen when one locks', () => {
    holdSessionKey('owner-1', KEY, sessionGeneration());
    renderTwo();
    expect(screen.getByText('inbox: unlocked')).toBeInTheDocument();
    expect(screen.getByText('tab: unlocked')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'lock tab' }).click());
    expect(screen.getByText('inbox: locked')).toBeInTheDocument();
    expect(screen.getByText('tab: locked')).toBeInTheDocument();
  });

  it('is gone after a sign-out', () => {
    holdSessionKey('owner-1', KEY, sessionGeneration());
    renderTwo();
    act(() => fake.emitAuth('SIGNED_OUT', null));
    expect(screen.getByText('inbox: locked')).toBeInTheDocument();
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('is gone when a different account signs in', () => {
    holdSessionKey('owner-1', KEY, sessionGeneration());
    renderTwo();
    act(() => fake.emitAuth('SIGNED_IN', 'someone-else'));
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('is never shown to another account, and is dropped on sight', () => {
    holdSessionKey('owner-1', KEY, sessionGeneration());
    auth.userId = 'owner-2';
    renderTwo();
    expect(screen.getByText('inbox: locked')).toBeInTheDocument();
    // Not even for the first frame, before the key is dropped.
    expect(seen).not.toContain('unlocked');
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('survives a token refresh for the same account', () => {
    holdSessionKey('owner-1', KEY, sessionGeneration());
    renderTwo();
    act(() => fake.emitAuth('TOKEN_REFRESHED', 'owner-1'));
    expect(screen.getByText('inbox: unlocked')).toBeInTheDocument();
  });
});

describe('an unlock still running when the session ends', () => {
  /** Starts an unlock whose key arrives only when the returned function is called. */
  async function startUnlock(): Promise<{ finish: () => Promise<void>; done: Promise<void> }> {
    renderTwo();
    await waitFor(() => expect(hook.isSetup).toBe(true));
    let resolve!: (key: CryptoKey) => void;
    keys.unlockOwnerKey.mockImplementationOnce(() => new Promise<CryptoKey>((r) => { resolve = r; }));
    let done!: Promise<void>;
    act(() => { done = hook.unlock('Opening-Pass-2030'); });
    return { finish: async () => { await act(async () => { resolve(KEY); await done; }); }, done };
  }

  it('completes normally when nothing happens meanwhile', async () => {
    const { finish } = await startUnlock();
    await finish();
    expect(sessionKeyFor('owner-1')).toBe(KEY);
    expect(screen.getByText('inbox: unlocked')).toBeInTheDocument();
  });

  it('is refused after a sign-out', async () => {
    const { finish } = await startUnlock();
    act(() => fake.emitAuth('SIGNED_OUT', null));
    await finish();
    expect(sessionKeyFor('owner-1')).toBeNull();
    expect(screen.getByText('inbox: locked')).toBeInTheDocument();
  });

  it('is refused after a switch to another account', async () => {
    const { finish } = await startUnlock();
    act(() => fake.emitAuth('SIGNED_IN', 'owner-2'));
    await finish();
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('is refused after a Lock', async () => {
    const { finish } = await startUnlock();
    act(() => lockEncryptionSession());
    await finish();
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('holdAfter refuses the same way (recovery, password change)', async () => {
    renderTwo();
    await waitFor(() => expect(hook.isSetup).toBe(true));
    let resolve!: (key: CryptoKey) => void;
    let held!: Promise<boolean>;
    act(() => { held = hook.holdAfter(() => new Promise<CryptoKey>((r) => { resolve = r; })); });
    act(() => fake.emitAuth('SIGNED_OUT', null));
    await act(async () => { resolve(KEY); await held; });
    expect(await held).toBe(false);
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('holdAfter is refused after a Lock (same account, so only the generation can tell)', async () => {
    renderTwo();
    await waitFor(() => expect(hook.isSetup).toBe(true));
    let resolve!: (key: CryptoKey) => void;
    let held!: Promise<boolean>;
    act(() => { held = hook.holdAfter(() => new Promise<CryptoKey>((r) => { resolve = r; })); });
    act(() => lockEncryptionSession());
    await act(async () => { resolve(KEY); await held; });
    expect(await held).toBe(false);
    expect(sessionKeyFor('owner-1')).toBeNull();
  });

  it('refuses a key for another account than the one signed in, even in the current generation', () => {
    act(() => fake.emitAuth('SIGNED_IN', 'owner-2'));
    expect(holdSessionKey('owner-1', KEY, sessionGeneration())).toBe(false);
    expect(sessionKeyFor('owner-1')).toBeNull();
    expect(holdSessionKey('owner-2', KEY, sessionGeneration())).toBe(true);
    expect(sessionKeyFor('owner-2')).toBe(KEY);
  });
});
