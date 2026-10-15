// The invitation landing page: the token comes from the fragment and leaves the address bar
// at once; each dead-link reason has its own explanation; a weak password never reaches the
// server; an accepted invitation signs the client in and records it as their first sign-in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; body: unknown }>,
  answers: {} as Record<string, unknown>,
  signIns: [] as unknown[],
}));

vi.mock('@/lib/publicEdge', () => ({
  invokePublicEdge: async (name: string, body: unknown, options: { parse?: (v: unknown) => unknown } = {}) => {
    h.calls.push({ name, body });
    const answer = h.answers[name];
    if (answer instanceof Error) throw answer;
    return options.parse ? options.parse(answer) : answer;
  },
}));
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

import { INVITE_LOGIN_PENDING_KEY, InvitePage } from '../public/InvitePage';

const TOKEN = 'A'.repeat(43);

function renderAt(url: string) {
  window.history.replaceState({}, '', url);
  const [path, hash] = url.split('#');
  render(
    <MemoryRouter initialEntries={[{ pathname: path, hash: hash ? `#${hash}` : '' }]}>
      <Routes>
        <Route path="/invite/*" element={<InvitePage />} />
        <Route path="/portal" element={<p>Portal home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.calls = [];
  h.signIns = [];
  h.answers = {
    'validate-portal-invite': { valid: true, contact: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' } },
    'accept-portal-invite': { success: true, email: 'ada@example.com' },
  };
  window.sessionStorage.clear();
});

describe('InvitePage', () => {
  it('reads the token from the fragment, then clears it from the address bar', async () => {
    renderAt(`/invite#token=${TOKEN}`);
    expect(await screen.findByText(/Welcome, Ada/)).toBeInTheDocument();
    expect(h.calls[0]).toEqual({ name: 'validate-portal-invite', body: { token: TOKEN } });
    expect(window.location.hash).toBe('');
  });

  it.each([
    ['used', /already been used/],
    ['expired', /has expired/],
    ['revoked', /no longer works/],
    ['not_found', /not valid/],
  ])('explains a %s link', async (reason, text) => {
    h.answers['validate-portal-invite'] = { valid: false, reason };
    renderAt(`/invite#token=${TOKEN}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('a link without a token never calls the server', async () => {
    renderAt('/invite');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/);
    expect(h.calls).toEqual([]);
  });

  it('keeps a weak password in the browser', async () => {
    renderAt(`/invite#token=${TOKEN}`);
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'weakpass' } });
    fireEvent.change(screen.getByLabelText('Password again'), { target: { value: 'weakpass' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up and sign in' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Add an uppercase letter.');
    expect(h.calls.map((c) => c.name)).toEqual(['validate-portal-invite']);
  });

  it('accepts, signs in with the new password and records it as the first sign-in', async () => {
    renderAt(`/invite#token=${TOKEN}`);
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'Abcdef1!' } });
    fireEvent.change(screen.getByLabelText('Password again'), { target: { value: 'Abcdef1!' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up and sign in' }));
    });
    await waitFor(() => expect(screen.getByText('Portal home')).toBeInTheDocument());
    expect(h.calls[1]).toEqual({ name: 'accept-portal-invite', body: { token: TOKEN, password: 'Abcdef1!' } });
    expect(h.signIns).toEqual([{ email: 'ada@example.com', password: 'Abcdef1!' }]);
    expect(window.sessionStorage.getItem(INVITE_LOGIN_PENDING_KEY)).toBe('1');
  });
});
