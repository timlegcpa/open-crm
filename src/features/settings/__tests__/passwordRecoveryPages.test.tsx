import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/usePublicBranding', () => ({ usePublicBranding: () => ({ displayName: 'Acme LLC', logoPath: null }) }));
vi.mock('@/lib/publicEdge', () => ({ publicProjectConfig: () => ({ url: 'https://project.example.com', anonKey: 'anon-key' }) }));

import { ForgotPasswordPage } from '../public/ForgotPasswordPage';
import { ResetPasswordPage } from '../public/ResetPasswordPage';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ForgotPasswordPage', () => {
  it('asks Auth for a reset link that lands on /reset-password', async () => {
    fetchMock.mockResolvedValue(answer(200));
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account uses that address/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://project.example.com/auth/v1/recover?redirect_to=${encodeURIComponent(`${window.location.origin}/reset-password`)}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ada@example.com' });
  });

  it('answers the same for an address Auth refuses, so it reveals no account', async () => {
    fetchMock.mockResolvedValue(answer(400, { error_code: 'validation_failed' }));
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account uses that address/)).toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  it('clears the token from the address (StrictMode too), sets the password with it, then ends every session', async () => {
    window.history.replaceState(null, '', '/reset-password#access_token=recovery-token&type=recovery');
    fetchMock.mockResolvedValue(answer(200));
    render(<StrictMode><MemoryRouter><ResetPasswordPage /></MemoryRouter></StrictMode>);
    await screen.findByLabelText('New password');
    expect(window.location.hash).toBe('');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'New-pass2!' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'New-pass2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeInTheDocument();
    const [[userUrl, userInit], [logoutUrl, logoutInit]] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(userUrl).toBe('https://project.example.com/auth/v1/user');
    expect(userInit.method).toBe('PUT');
    expect((userInit.headers as Record<string, string>).Authorization).toBe('Bearer recovery-token');
    expect(JSON.parse(userInit.body as string)).toEqual({ password: 'New-pass2!' });
    expect(logoutUrl).toBe('https://project.example.com/auth/v1/logout?scope=global');
    expect(logoutInit.method).toBe('POST');
  });

  it('a link with no recovery token offers a new link and sends nothing', async () => {
    window.history.replaceState(null, '', '/reset-password#error=access_denied&error_code=otp_expired');
    render(<StrictMode><MemoryRouter><ResetPasswordPage /></MemoryRouter></StrictMode>);
    expect(await screen.findByText('Ask for a new link')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed sign-out of the other devices is said, never shown as done, and can be retried with the same token', async () => {
    window.history.replaceState(null, '', '/reset-password#access_token=recovery-token&type=recovery');
    fetchMock
      .mockResolvedValueOnce(answer(200))
      .mockResolvedValueOnce(answer(500))
      .mockResolvedValueOnce(answer(200));
    render(<StrictMode><MemoryRouter><ResetPasswordPage /></MemoryRouter></StrictMode>);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'New-pass2!' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'New-pass2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Other signed-in devices could not be signed out. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/every signed-in device is signed out/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }));
    expect(await screen.findByText(/every signed-in device is signed out/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [retryUrl, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(retryUrl).toBe('https://project.example.com/auth/v1/logout?scope=global');
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer recovery-token');
  });

  it('a password Auth refuses for two-factor says why and keeps the form', async () => {
    window.history.replaceState(null, '', '/reset-password#access_token=recovery-token&type=recovery');
    fetchMock.mockResolvedValue(answer(403, { error_code: 'insufficient_aal' }));
    render(<StrictMode><MemoryRouter><ResetPasswordPage /></MemoryRouter></StrictMode>);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'New-pass2!' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'New-pass2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/Two-factor is on for this account/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('New password')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
