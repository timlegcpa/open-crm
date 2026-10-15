// Password change on Profile: the current password is checked first, on a throwaway client
// so the app's own (possibly two-factor) session is untouched; when Auth also wants
// its own proof (reauthentication_needed), the emailed code is asked for and sent with the
// new password; other devices are signed out after; and the form is off during a view.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  viewing: false,
  calls: [] as Array<[string, unknown]>,
  updateAnswers: [] as Array<{ error: unknown }>,
  signInError: null as unknown,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: { user: { email: 'ada@example.com' } }, isViewAsClientSession: h.viewing }),
}));
vi.mock('../api', () => ({
  portalKeys: { myContact: () => ['portal', 'my-contact'] },
  getMyContact: async () => ({ id: 'c-1', full_name: 'Ada Lovelace', email: 'ada@example.com', phone: null, business_name: null }),
}));
// The shared change and code helpers run for real (on the mocked app client below); only the
// throwaway-client check is stood in for.
vi.mock('@/lib/passwordChange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/passwordChange')>()),
  verifyCurrentPassword: async (email: string, password: string) => {
    h.calls.push(['verify', { email, password }]);
    return h.signInError === null;
  },
}));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' }, error: null }),
        // Settings' two-factor section (the portal profile slot) reads the factors on mount.
        listFactors: async () => ({ data: { totp: [] }, error: null }),
      },
      // The app's own client must never sign in again: that would drop a two-factor session.
      signInWithPassword: async (v: unknown) => {
        h.calls.push(['main-client-signIn', v]);
        return { data: {}, error: null };
      },
      updateUser: async (v: unknown) => {
        h.calls.push(['updateUser', v]);
        return h.updateAnswers.shift() ?? { error: null };
      },
      reauthenticate: async () => {
        h.calls.push(['reauthenticate', null]);
        return { error: null };
      },
      signOut: async (v: unknown) => {
        h.calls.push(['signOut', v]);
        return { error: null };
      },
    },
  }),
}));

vi.mock('@/hooks/usePublicBranding', () => ({ usePublicBranding: () => ({ displayName: 'Acme LLC', logoPath: null }) }));

import { PortalProfilePage } from '../pages/ProfilePage';

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PortalProfilePage />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Oldpass1!' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Newpass1!' } });
  fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'Newpass1!' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
  });
}

beforeEach(() => {
  h.viewing = false;
  h.calls = [];
  h.updateAnswers = [];
  h.signInError = null;
});

describe('Profile password change', () => {
  it('checks the current password, saves, then signs out the other devices only', async () => {
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(h.calls.map((c) => c[0])).toEqual(['verify', 'updateUser', 'signOut']));
    expect(h.calls[0][1]).toEqual({ email: 'ada@example.com', password: 'Oldpass1!' });
    expect(h.calls[1][1]).toEqual({ password: 'Newpass1!' });
    expect(h.calls[2][1]).toEqual({ scope: 'others' });
  });

  it('a wrong current password changes nothing', async () => {
    h.signInError = { message: 'Invalid login credentials' };
    renderPage();
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is not right.');
    expect(h.calls.map((c) => c[0])).toEqual(['verify']);
  });

  it("when Auth wants its own proof, asks for the emailed code and sends it with the password", async () => {
    h.updateAnswers = [{ error: { code: 'reauthentication_needed', message: 'Password update requires reauthentication' } }];
    renderPage();
    await fillAndSubmit();
    const codeField = await screen.findByLabelText('Code from the email');
    expect(h.calls.map((c) => c[0])).toEqual(['verify', 'updateUser', 'reauthenticate']);
    fireEvent.change(codeField, { target: { value: ' 123456 ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm and change password' }));
    });
    await waitFor(() => expect(h.calls.map((c) => c[0])).toEqual(['verify', 'updateUser', 'reauthenticate', 'updateUser', 'signOut']));
    expect(h.calls[3][1]).toEqual({ password: 'Newpass1!', nonce: '123456' });
  });

  it('is off while viewing as client', async () => {
    h.viewing = true;
    renderPage();
    expect(await screen.findByText('Password and two-factor settings are off while viewing as client.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });
});

describe('Profile two-factor', () => {
  it("shows settings' two-factor section through the profile slot", async () => {
    renderPage();
    expect(await screen.findByText('Two-factor sign-in')).toBeInTheDocument();
  });

  it('leaves it out while viewing as client', async () => {
    h.viewing = true;
    renderPage();
    await screen.findByText('Password and two-factor settings are off while viewing as client.');
    // Give a lazy section the chance to load, then check it never rendered.
    await act(async () => {
      await import('@/features/settings/TwoFactorSection');
    });
    expect(screen.queryByText('Two-factor sign-in')).toBeNull();
  });
});
