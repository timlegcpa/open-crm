// The two screens before the app: the sign-in form says once why the portal signed a tab
// out, and the second-factor challenge reaches the backup-code recovery and back.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  useAuth: () => ({ login: async () => 'ok', completeMfa: async () => undefined, logout: async () => undefined }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ auth: {} }), supabaseConfigured: true }));

import { MfaChallenge } from '@/components/auth/MfaChallenge';
import { SignInForm } from '@/components/auth/SignInForm';
import { SESSION_EXPIRED_KEY } from '@/lib/auth';

const renderSignIn = () =>
  render(
    <MemoryRouter>
      <SignInForm orgName="Acme LLC" />
    </MemoryRouter>,
  );

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('SignInForm', () => {
  it('says the portal signed this tab out for inactivity, once, and removes the flag', () => {
    window.sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
    const first = renderSignIn();
    expect(screen.getByRole('status')).toHaveTextContent('You were signed out after a period of inactivity.');
    expect(window.sessionStorage.getItem(SESSION_EXPIRED_KEY)).toBeNull();
    first.unmount();
    renderSignIn();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing without the flag', () => {
    renderSignIn();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

describe('MfaChallenge', () => {
  it('reaches the backup-code recovery from the code screen, and goes back', async () => {
    render(<MfaChallenge />);
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use a backup code' }));
    });
    expect(await screen.findByLabelText('Backup code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use backup code' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the authenticator instead' }));
    });
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    expect(screen.queryByLabelText('Backup code')).toBeNull();
  });
});
