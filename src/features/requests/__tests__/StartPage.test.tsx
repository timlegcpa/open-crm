// The start link's landing page: the token comes from the fragment and leaves the address
// bar at once; a weak or mismatched password never reaches the server; a redeemed link
// signs the client in and opens the request; a used link offers sign in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PORTAL_LOGIN_PENDING_KEY } from '@/lib/auth';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; body: unknown }>,
  answer: null as unknown,
  signIns: [] as unknown[],
}));

vi.mock('@/lib/publicEdge', async () => {
  const core = await import('@/lib/edgeCore');
  return {
    isEdgeError: core.isEdgeError,
    invokePublicEdge: async (name: string, body: unknown, options: { parse?: (v: unknown) => unknown } = {}) => {
      h.calls.push({ name, body });
      if (h.answer instanceof Error) throw h.answer;
      return options.parse ? options.parse(h.answer) : h.answer;
    },
  };
});
vi.mock('@/components/layout/PublicPage', () => ({
  PublicPage: ({ title, children }: { title?: string; children: React.ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      signInWithPassword: async (credentials: unknown) => {
        h.signIns.push(credentials);
        return { data: {}, error: null };
      },
    },
  }),
}));

import { EdgeError } from '@/lib/edgeCore';
import { readStartToken, START_LOGIN_PENDING_KEY, StartPage } from '../public/StartPage';

const TOKEN = 'S'.repeat(43);
const LIST = '00000000-0000-4000-8000-0000000000aa';
const PASSWORD = 'Correct-Horse-9';

function renderAt(hash: string) {
  window.history.replaceState({}, '', `/start${hash}`);
  render(
    <MemoryRouter initialEntries={[{ pathname: '/start', hash }]}>
      <Routes>
        <Route path="/start/*" element={<StartPage />} />
        <Route path="/portal" element={<p>Portal home</p>} />
        <Route path="/portal/requests/:id" element={<p>The request</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const fill = (password: string, confirm = password) => {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Password again'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up and sign in' }));
};

beforeEach(() => {
  h.calls = [];
  h.signIns = [];
  h.answer = { success: true, email: 'ada@example.com', contact_id: '10000000-0000-4000-8000-000000000001', needs_list_id: LIST };
  window.sessionStorage.clear();
});

describe('the start page', () => {
  it('shares the first-sign-in key with the app', () => {
    expect(START_LOGIN_PENDING_KEY).toBe(PORTAL_LOGIN_PENDING_KEY);
  });

  it('reads only a well-formed token from the fragment', () => {
    expect(readStartToken(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readStartToken('#token=short')).toBeNull();
    expect(readStartToken('')).toBeNull();
  });

  it('takes the token out of the address bar, redeems it and opens the request', async () => {
    renderAt(`#token=${TOKEN}`);
    expect(window.location.hash).toBe('');
    fill(PASSWORD);
    await screen.findByText('The request');
    expect(h.calls).toEqual([{ name: 'accept-start-link', body: { token: TOKEN, password: PASSWORD, confirm_password: PASSWORD } }]);
    expect(h.signIns).toEqual([{ email: 'ada@example.com', password: PASSWORD }]);
    expect(window.sessionStorage.getItem(START_LOGIN_PENDING_KEY)).toBe('1');
  });

  it('never sends a weak or mismatched password', async () => {
    renderAt(`#token=${TOKEN}`);
    fill('weak');
    expect(await screen.findByRole('alert')).toBeTruthy();
    fill(PASSWORD, 'Correct-Horse-8');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not match/));
    expect(h.calls).toEqual([]);
  });

  it('a used link says so and offers sign in', async () => {
    h.answer = new EdgeError('invalid', { status: 410, code: 'link_used', message: 'This link was already used. Sign in instead.' });
    renderAt(`#token=${TOKEN}`);
    fill(PASSWORD);
    expect((await screen.findByRole('alert')).textContent).toMatch(/already used/);
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeTruthy();
  });

  it('without a token, explains and calls nothing', () => {
    renderAt('');
    expect(screen.getByRole('alert').textContent).toMatch(/not complete/);
    expect(h.calls).toEqual([]);
  });
});
