import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase', async () => (await import('@/__tests__/fakeSupabase')).supabaseModule);
const changeSignInEmail = vi.fn();
vi.mock('@/features/portal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/portal/api')>()),
  changeSignInEmail: (...args: unknown[]) => changeSignInEmail(...args),
}));

import { fake } from '@/__tests__/fakeSupabase';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';

const ADA = '10000000-0000-4000-8000-00000000000a';
const ACCOUNT = '10000000-0000-4000-8000-0000000000a1';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const email = (id: string, address: string, extra: Record<string, unknown> = {}) => ({
  id, contact_id: ADA, kind: 'primary', email: address, label: 'personal', is_default: false, created_at: '2026-03-01T15:00:00Z', ...extra,
});

const account = (extra: Record<string, unknown> = {}) => ({
  id: ACCOUNT, user_id: 'user-1', contact_id: ADA, role: 'primary', status: 'active', invited_email: 'ada@example.com',
  invited_at: '2026-03-01T15:00:00Z', activated_at: '2026-03-02T15:00:00Z', last_login_at: null, login_count: 1, ...extra,
});

beforeEach(() => {
  fake.reset();
  changeSignInEmail.mockReset();
  fake.state.session = { user: { id: 'owner-1', email: 'owner@example.com' } };
  fake.state.tables.contacts = [{ id: ADA, portal_sidebar_config: {} }];
  fake.state.tables.contact_emails = [
    email('e1', 'ada@example.com', { is_default: true }),
    email('e2', 'ada.work@example.com', { label: 'business' }),
  ];
  fake.state.tables.client_portal_accounts = [account()];
});

const rowOf = async (address: string) => (await screen.findByText(address)).closest('li') as HTMLElement;

describe('ContactEmailsManager and the portal sign-in', () => {
  it('marks only the address an account signs in with', async () => {
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    expect(await within(await rowOf('ada@example.com')).findByText('Portal sign-in')).toBeInTheDocument();
    expect(within(await rowOf('ada.work@example.com')).queryByText('Portal sign-in')).not.toBeInTheDocument();
  });

  it('an invitation not yet accepted or a deactivated account is not a sign-in', async () => {
    fake.state.tables.client_portal_accounts = [
      account({ user_id: null, status: 'invited' }),
      account({ id: 'other', status: 'deactivated', invited_email: 'ada.work@example.com' }),
    ];
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    await waitFor(() => expect(fake.calls('client_portal_accounts', 'select').length).toBeGreaterThan(0));
    await rowOf('ada@example.com');
    expect(screen.queryByText('Portal sign-in')).not.toBeInTheDocument();
  });

  it('editing the sign-in address moves the sign-in, compare-and-swapped on the address shown, and never writes the row itself', async () => {
    changeSignInEmail.mockResolvedValue({ success: true, contact_address: 'email' });
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    await within(await rowOf('ada@example.com')).findByText('Portal sign-in');
    fireEvent.click(within(await rowOf('ada@example.com')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Changing it changes the sign-in too/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ada@example.com' }), { target: { value: 'ada.new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(changeSignInEmail).toHaveBeenCalledWith(ACCOUNT, 'ada.new@example.com', 'ada@example.com'));
    expect(fake.calls('contact_emails', 'update')).toHaveLength(0);
    expect(fake.calls('contact_emails', 'delete')).toHaveLength(0);
  });

  it('a listed sign-in address is moved by the server alone: the screen deletes nothing', async () => {
    fake.state.tables.client_portal_accounts = [account({ invited_email: 'ada.work@example.com' })];
    changeSignInEmail.mockResolvedValue({ success: true, contact_address: 'email_list' });
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    await within(await rowOf('ada.work@example.com')).findByText('Portal sign-in');
    fireEvent.click(within(await rowOf('ada.work@example.com')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ada.work@example.com' }), { target: { value: 'ada.office@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(changeSignInEmail).toHaveBeenCalledWith(ACCOUNT, 'ada.office@example.com', 'ada.work@example.com'));
    expect(fake.calls('contact_emails', 'delete')).toHaveLength(0);
  });

  it('a refused change says why and leaves the row as it was', async () => {
    changeSignInEmail.mockRejectedValue(new Error('Another portal account already uses that address.'));
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    await within(await rowOf('ada@example.com')).findByText('Portal sign-in');
    fireEvent.click(within(await rowOf('ada@example.com')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ada@example.com' }), { target: { value: 'taken@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another portal account already uses that address.');
    expect(fake.state.tables.contact_emails[0]).toMatchObject({ email: 'ada@example.com' });
  });

  it('an address that is not a sign-in is still a plain row update', async () => {
    render(<ContactEmailsManager contactId={ADA} kind="primary" />, { wrapper });
    await within(await rowOf('ada@example.com')).findByText('Portal sign-in');
    fireEvent.click(within(await rowOf('ada.work@example.com')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ada.work@example.com' }), { target: { value: 'ada.office@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls('contact_emails', 'update')).toHaveLength(1));
    expect(changeSignInEmail).not.toHaveBeenCalled();
  });
});
