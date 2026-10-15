import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// A public page: reaching the Supabase client or the auth provider fails the import.
vi.mock('@/lib/supabase', () => {
  throw new Error('the unsubscribe page imported @/lib/supabase');
});
vi.mock('@supabase/supabase-js', () => {
  throw new Error('the unsubscribe page imported @supabase/supabase-js');
});

import { UnsubscribePage } from '../public/UnsubscribePage';

const TOKEN = 'Abc_def-123'.repeat(4);
interface Seen { url: string; method: string; credentials?: string; body?: unknown }
let seen: Seen[];

function stub(answers: Array<{ status: number; body?: unknown }>) {
  seen = [];
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).includes('/rest/v1/rpc/get_org_branding')) return new Response(JSON.stringify({ display_name: 'Acme LLC' }), { status: 200 });
    seen.push({ url: String(url), method: init.method ?? 'GET', credentials: init.credentials, body: init.body });
    const next = answers.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  }));
}

const renderAt = (query: string) =>
  render(
    <MemoryRouter initialEntries={[`/unsubscribe${query}`]}>
      <UnsubscribePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  seen = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the unsubscribe page', () => {
  it('opening it only asks (a GET, no cookies); the button posts', async () => {
    stub([{ status: 200, body: { state: 'confirm' } }, { status: 200, body: { state: 'unsubscribed' } }]);
    renderAt(`?t=${TOKEN}`);
    const button = await screen.findByRole('button', { name: 'Unsubscribe' });
    expect(screen.getByText(/stop receiving group emails from Acme LLC/)).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(new URL(seen[0].url).searchParams.get('t')).toBe(TOKEN);
    fireEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'You are unsubscribed' })).toBeInTheDocument();
    expect(seen[1]).toMatchObject({ method: 'POST', credentials: 'omit', body: undefined });
  });

  it('a used link says so without a button', async () => {
    stub([{ status: 200, body: { state: 'unsubscribed' } }]);
    renderAt(`?t=${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'You are unsubscribed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
  });

  it('a link with no token never calls the server', async () => {
    stub([]);
    renderAt('');
    expect(await screen.findByRole('heading', { name: 'This link could not be read' })).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('an unknown token reads as unreadable', async () => {
    stub([{ status: 410, body: { state: 'invalid' } }]);
    renderAt(`?t=${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'This link could not be read' })).toBeInTheDocument();
  });

  it('a limiter that could not answer, and a rate limit, each get their own message', async () => {
    stub([{ status: 503, body: { error: 'Temporarily unavailable. Try again later.', code: 'unavailable' } }]);
    const first = renderAt(`?t=${TOKEN}`);
    expect(await screen.findByText(/link in your email still works, so try again/)).toBeInTheDocument();
    first.unmount();
    vi.unstubAllGlobals();
    stub([{ status: 429, body: { error: 'Too many requests. Try again later.', code: 'rate_limited' } }]);
    renderAt(`?t=${TOKEN}`);
    expect(await screen.findByText(/too many requests from your network/)).toBeInTheDocument();
  });

  it('a server error offers another try', async () => {
    stub([{ status: 500, body: { error: 'Something went wrong. Try again.' } }, { status: 200, body: { state: 'confirm' } }]);
    renderAt(`?t=${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument());
  });
});
