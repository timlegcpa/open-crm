// The current-password check (owner and client alike) runs on a throwaway client: nothing stored, nothing refreshed,
// its own storage key, signed out at once, and the app's own client is never touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  options: [] as unknown[],
  signIns: [] as unknown[],
  signOuts: [] as unknown[],
  answer: { data: { session: { access_token: 'a' } }, error: null } as { data: { session: unknown }; error: unknown },
  mainClientUsed: false,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    h.options.push(options);
    return {
      auth: {
        signInWithPassword: async (v: unknown) => {
          h.signIns.push(v);
          return h.answer;
        },
        signOut: async (v: unknown) => {
          h.signOuts.push(v);
          return { error: null };
        },
      },
    };
  },
}));
vi.mock('@/lib/publicEdge', () => ({ publicProjectConfig: () => ({ url: 'https://example.supabase.co', anonKey: 'anon' }) }));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => {
    h.mainClientUsed = true;
    throw new Error('the main client must not be used');
  },
}));

import { verifyCurrentPassword } from '../passwordChange';

beforeEach(() => {
  h.options = [];
  h.signIns = [];
  h.signOuts = [];
  h.mainClientUsed = false;
  h.answer = { data: { session: { access_token: 'a' } }, error: null };
});

describe('verifyCurrentPassword', () => {
  it('signs in on a client that keeps nothing, then signs that session out', async () => {
    expect(await verifyCurrentPassword('ada@example.com', 'Oldpass1!')).toBe(true);
    expect(h.options).toEqual([
      { auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'open-crm-reauth' }) },
    ]);
    expect(h.signIns).toEqual([{ email: 'ada@example.com', password: 'Oldpass1!' }]);
    expect(h.signOuts).toEqual([{ scope: 'local' }]);
    expect(h.mainClientUsed).toBe(false);
  });

  it('a wrong password is false, and there is nothing to sign out', async () => {
    h.answer = { data: { session: null }, error: { message: 'Invalid login credentials' } };
    expect(await verifyCurrentPassword('ada@example.com', 'nope')).toBe(false);
    expect(h.signOuts).toEqual([]);
  });
});
