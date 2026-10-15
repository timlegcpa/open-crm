import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Result = { data?: unknown; error: unknown };

const fake = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    errors: {} as Record<string, unknown>,
    writes: [] as Array<{ table: string; op: string; payload?: unknown; key?: unknown }>,
    auth: {
      signInWithPassword: vi.fn(),
      updateUser: vi.fn(async (_attrs: unknown): Promise<Result> => ({ data: {}, error: null })),
      reauthenticate: vi.fn(async (): Promise<Result> => ({ data: {}, error: null })),
      signOut: vi.fn(async (): Promise<Result> => ({ error: null })),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { all: [], totp: [] }, error: null })),
        enroll: vi.fn(async () => ({ data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;base64,AA==', secret: 'SECRETKEY' } }, error: null })),
        challenge: vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null })),
        verify: vi.fn(async (): Promise<Result> => ({ error: null })),
        unenroll: vi.fn(async (): Promise<Result> => ({ error: null })),
      },
    },
  };
  const result = (key: string, data: unknown): Result => (state.errors[key] ? { data: null, error: state.errors[key] } : { data, error: null });
  const client = {
    auth: state.auth,
    from: (table: string) => {
      // A read returns only the columns it asked for, as PostgREST does.
      const project = (columns: string) => {
        const names = columns.split(',').map((c) => c.trim());
        return (state.rows[table] ?? []).map((row) => Object.fromEntries(names.filter((n) => n in row).map((n) => [n, row[n]])));
      };
      // A write selected back returns the rows it touched: none when the key is not there.
      const touched = (col: string, value: unknown) =>
        (state.rows[table] ?? []).filter((row) => row[col] === value).map((row) => ({ [col]: row[col] }));
      return {
        select: (columns: string) => {
          const ordered = {
            order: () => ordered,
            // One page: the lists here are short, so the keyset never advances.
            limit: () => ordered,
            gt: () => ordered,
            maybeSingle: async () => result(`${table}:select`, project(columns)[0] ?? null),
            then: (resolve: (r: Result) => unknown) => resolve(result(`${table}:select`, project(columns))),
          };
          return ordered;
        },
        update: (payload: unknown) => ({
          eq: (col: string, key: unknown) => ({
            select: async () => {
              state.writes.push({ table, op: 'update', payload, key });
              return result(`${table}:update`, touched(col, key));
            },
          }),
        }),
        delete: () => ({
          eq: (col: string, key: unknown) => ({
            select: async () => {
              state.writes.push({ table, op: 'delete', key });
              return result(`${table}:delete`, touched(col, key));
            },
          }),
        }),
        insert: async (payload: unknown) => {
          state.writes.push({ table, op: 'insert', payload });
          return result(`${table}:insert`, null);
        },
      };
    },
  };
  return { state, client };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const api = vi.hoisted(() => ({
  verifyCurrentPassword: vi.fn(async () => true),
  generateBackupCodes: vi.fn(async (): Promise<string[]> => ['AAAA-BBBB', 'CCCC-DDDD']),
  revokeBackupCodes: vi.fn(async () => undefined),
  fetchVerifiedTotp: vi.fn(async (): Promise<{ id: string; status: string } | null> => null),
  recordAudit: vi.fn(async (_action: string, _details?: unknown) => true),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => fake.client }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/usePublicBranding', () => ({ usePublicBranding: () => ({ displayName: 'Acme LLC', logoPath: null }) }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: { user: { id: '00000000-0000-4000-8000-000000000001', email: 'ada@example.com' } } }),
}));
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), ...api }));
vi.mock('@/lib/passwordChange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/passwordChange')>()),
  verifyCurrentPassword: api.verifyCurrentPassword,
}));

import { LEAD_SOURCES, CONTACT_STATUSES, definePickList, ORGANIZATION_TYPES, type LeadSource } from '@/api/pickLists';
import { IdentitySection } from '../IdentitySection';
import { NothingChangedError, removeLogo, saveIdentity } from '../api';
import { PickListEditor } from '../PickListEditor';
import { TwoFactorSection } from '../TwoFactorSection';
import { SecuritySection } from '../SecuritySection';

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  fake.state.rows = {};
  fake.state.errors = {};
  fake.state.writes = [];
  vi.clearAllMocks();
  api.verifyCurrentPassword.mockResolvedValue(true);
  api.generateBackupCodes.mockResolvedValue(['AAAA-BBBB', 'CCCC-DDDD']);
  api.revokeBackupCodes.mockResolvedValue(undefined);
  api.fetchVerifiedTotp.mockResolvedValue(null);
});

describe('PickListEditor', () => {
  it('a fixed list offers no add, delete or on/off', async () => {
    fake.state.rows.contact_statuses = [
      { key: 'new_lead', label: 'New lead', colour: null, sort_order: 10 },
      { key: 'active', label: 'Active', colour: '#16a34a', sort_order: 20 },
    ];
    wrap(<PickListEditor title="Pipeline stages" list={CONTACT_STATUSES} shape="fixed" />);
    expect(await screen.findByLabelText('Name of New lead')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Delete /)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('Name of the new entry')).toBeNull();
  });

  it('a built-in row shows no delete and no on/off', async () => {
    fake.state.rows.organization_types = [
      { key: 'individual', label: 'Individual', colour: null, sort_order: 10, is_active: true, is_system: true },
      { key: 'club', label: 'Club', colour: null, sort_order: 20, is_active: true, is_system: false },
    ];
    wrap(<PickListEditor title="Organization types" list={ORGANIZATION_TYPES} shape="open" />);
    await screen.findByLabelText('Name of Club');
    expect(screen.queryByLabelText('Delete Individual')).toBeNull();
    expect(screen.queryByLabelText('Offer Individual on new records')).toBeNull();
    expect(screen.getByLabelText('Delete Club')).toBeInTheDocument();
    expect(screen.getByLabelText('Offer Club on new records')).toBeInTheDocument();
  });

  it('a row something uses cannot be deleted, and says to deactivate it', async () => {
    fake.state.rows.lead_sources = [{ key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false }];
    fake.state.errors['lead_sources:delete'] = { code: '23503', message: 'violates foreign key constraint' };
    wrap(<PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" />);
    fireEvent.click(await screen.findByLabelText('Delete Referral'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('In use; deactivate it instead.'));
  });

  it('a failed rename rolls back to the saved label', async () => {
    fake.state.rows.lead_sources = [{ key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false }];
    fake.state.errors['lead_sources:update'] = { code: '23505' };
    wrap(<PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" />);
    const input = await screen.findByLabelText('Name of Referral');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Word of mouth' } });
    fireEvent.blur(input);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A row with that name already exists.'));
    expect(await screen.findByLabelText('Name of Referral')).toHaveValue('Referral');
    expect(fake.state.writes).toContainEqual({ table: 'lead_sources', op: 'update', payload: { label: 'Word of mouth' }, key: 'referral' });
  });

  it('a lead source that is not built in can be deleted and turned off; a built-in one cannot', async () => {
    fake.state.rows.lead_sources = [
      { key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false },
      { key: 'lead_intake', label: 'Lead intake', colour: null, sort_order: 20, is_active: true, is_system: true },
    ];
    wrap(<PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" />);
    expect(await screen.findByLabelText('Delete Referral')).toBeInTheDocument();
    expect(screen.getByLabelText('Offer Referral on new records')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete Lead intake')).toBeNull();
    expect(screen.queryByLabelText('Offer Lead intake on new records')).toBeNull();
  });

  it('a list read without is_system is treated as built in: no delete, no on/off', async () => {
    fake.state.rows.lead_sources = [{ key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false }];
    // A spec that does not select is_system: the rows arrive without it.
    const withoutIsSystem = definePickList<LeadSource>('lead_sources', 'key, label, colour, sort_order, is_active');
    wrap(<PickListEditor title="Lead sources" list={withoutIsSystem} shape="open" />);
    await screen.findByLabelText('Name of Referral');
    expect(screen.queryByLabelText('Delete Referral')).toBeNull();
    expect(screen.queryByLabelText('Offer Referral on new records')).toBeNull();
  });

  it('a rename that changes no row (the row is gone) is a failure, never a save', async () => {
    fake.state.rows.lead_sources = [{ key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false }];
    wrap(<PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" />);
    const input = await screen.findByLabelText('Name of Referral');
    fake.state.rows.lead_sources = [];
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Word of mouth' } });
    fireEvent.blur(input);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nothing was saved. Reload the page and try again.'));
  });

  it('adds a row with a key made from its label', async () => {
    fake.state.rows.lead_sources = [{ key: 'referral', label: 'Referral', colour: null, sort_order: 10, is_active: true, is_system: false }];
    wrap(<PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" />);
    fireEvent.change(await screen.findByLabelText('Name of the new entry'), { target: { value: 'Trade show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(fake.state.writes).toContainEqual({
        table: 'lead_sources',
        op: 'insert',
        payload: { key: 'trade_show', label: 'Trade show', colour: null, sort_order: 20 },
      }),
    );
  });
});

async function enrollAndVerify() {
  fireEvent.click(await screen.findByRole('button', { name: /Turn on two-factor/ }));
  const otp = await screen.findByLabelText('Six-digit code from the app');
  fireEvent.change(otp, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));
}

describe('writes that change no row', () => {
  const profile = { display_name: 'Acme LLC', legal_name: null, sender_name: null, postal_address: null, logo_path: null, brand: {} };

  it('saveIdentity and removeLogo throw when org_profile has no row to change', async () => {
    fake.state.rows.org_profile = [];
    await expect(saveIdentity(profile, { display_name: 'Acme', legal_name: null, sender_name: null, postal_address: null, primary_color: null })).rejects.toBeInstanceOf(NothingChangedError);
    await expect(removeLogo()).rejects.toBeInstanceOf(NothingChangedError);
    fake.state.rows.org_profile = [{ id: true, ...profile }];
    await expect(removeLogo()).resolves.toBeUndefined();
  });

  it('the identity form shows no success when nothing was saved', async () => {
    fake.state.rows.org_profile = [{ id: true, ...profile }];
    wrap(<IdentitySection />);
    const name = await screen.findByLabelText('Name');
    fake.state.rows.org_profile = [];
    fireEvent.change(name, { target: { value: 'Acme Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nothing was saved. Reload the page and try again.'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.recordAudit).not.toHaveBeenCalled();
  });
});

describe('TwoFactorSection', () => {
  it('shows the codes once, and Done waits for "I have saved these codes"', async () => {
    const onEvent = vi.fn();
    wrap(<TwoFactorSection onEvent={onEvent} />);
    await enrollAndVerify();
    expect(await screen.findByText('AAAA-BBBB')).toBeInTheDocument();
    expect(onEvent).toHaveBeenCalledWith({ action: 'mfa_enabled', details: {} });
    expect(fake.state.auth.mfa.enroll).toHaveBeenCalledWith({ factorType: 'totp', friendlyName: 'Acme LLC sign-in' });
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I have saved these codes'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(await screen.findByRole('button', { name: 'Make new backup codes' })).toBeInTheDocument();
  });

  it('a failed code generation leaves two-factor on, with a way to retry', async () => {
    api.generateBackupCodes.mockRejectedValueOnce(new Error('boom'));
    wrap(<TwoFactorSection />);
    await enrollAndVerify();
    expect(await screen.findByRole('button', { name: 'Make new backup codes' })).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(fake.state.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Two-factor is on, but backup codes could not be made/));
  });

  it('turning off removes the authenticator, then says so out loud when the codes were not cleared', async () => {
    api.fetchVerifiedTotp.mockResolvedValue({ id: 'factor-9', status: 'verified' });
    api.revokeBackupCodes.mockRejectedValueOnce(new Error('down'));
    const onEvent = vi.fn();
    wrap(<TwoFactorSection onEvent={onEvent} />);
    fireEvent.click(await screen.findByRole('button', { name: /Turn off two-factor/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(fake.state.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'factor-9' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/old backup codes were not cleared/)));
    expect(onEvent).toHaveBeenCalledWith({ action: 'mfa_disabled', details: { backup_codes_revoked: false } });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('Password change', () => {
  const fill = (current: string, next: string) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  };

  it('checks the current password on the throwaway client, keeps this session, and signs out the others', async () => {
    wrap(<SecuritySection />);
    fill('Old-pass1!', 'New-pass2!');
    await waitFor(() => expect(fake.state.auth.updateUser).toHaveBeenCalledWith({ password: 'New-pass2!' }));
    expect(api.verifyCurrentPassword).toHaveBeenCalledWith('ada@example.com', 'Old-pass1!');
    expect(fake.state.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(fake.state.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    await waitFor(() => expect(api.recordAudit).toHaveBeenCalledWith('password_change', { other_sessions_revoked: true }));
  });

  it('a wrong current password changes nothing, and five lock the form', async () => {
    api.verifyCurrentPassword.mockResolvedValue(false);
    wrap(<SecuritySection />);
    for (let i = 0; i < 5; i += 1) {
      fill('Wrong-pass1!', 'New-pass2!');
      await waitFor(() => expect(api.verifyCurrentPassword).toHaveBeenCalledTimes(i + 1));
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(i + 1));
    }
    expect(fake.state.auth.updateUser).not.toHaveBeenCalled();
    expect(await screen.findByText('Too many wrong passwords. Wait 30 seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('when Auth asks for a recent sign-in, it emails a code and sends it as the nonce', async () => {
    fake.state.auth.updateUser.mockImplementationOnce(async () => ({
      data: null,
      error: { code: 'reauthentication_needed', message: 'Password update requires reauthentication' },
    }));
    wrap(<SecuritySection />);
    fill('Old-pass1!', 'New-pass2!');
    await waitFor(() => expect(fake.state.auth.reauthenticate).toHaveBeenCalledTimes(1));
    expect(fake.state.auth.signOut).not.toHaveBeenCalled();
    expect(api.recordAudit).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '483920' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and change password' }));
    await waitFor(() => expect(fake.state.auth.updateUser).toHaveBeenLastCalledWith({ password: 'New-pass2!', nonce: '483920' }));
    await waitFor(() => expect(fake.state.auth.signOut).toHaveBeenCalledWith({ scope: 'others' }));
    await waitFor(() => expect(api.recordAudit).toHaveBeenCalledWith('password_change', { other_sessions_revoked: true }));
    expect(screen.queryByLabelText('Code from the email')).toBeNull();
  });

  it('a wrong emailed code changes nothing and keeps asking for the code', async () => {
    fake.state.auth.updateUser
      .mockImplementationOnce(async () => ({ data: null, error: { code: 'reauthentication_needed' } }))
      .mockImplementationOnce(async () => ({ data: null, error: { code: 'reauthentication_not_valid' } }));
    wrap(<SecuritySection />);
    fill('Old-pass1!', 'New-pass2!');
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and change password' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/code is not right/)));
    expect(fake.state.auth.updateUser).toHaveBeenCalledTimes(2);
    expect(fake.state.auth.signOut).not.toHaveBeenCalled();
    expect(api.recordAudit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Code from the email')).toBeInTheDocument();
  });

  it('any other refusal from Auth changes nothing and asks for no code', async () => {
    fake.state.auth.updateUser.mockImplementationOnce(async () => ({ data: null, error: { code: 'weak_password' } }));
    wrap(<SecuritySection />);
    fill('Old-pass1!', 'New-pass2!');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The password was not changed. Try again.'));
    expect(fake.state.auth.reauthenticate).not.toHaveBeenCalled();
    expect(fake.state.auth.signOut).not.toHaveBeenCalled();
  });

  it('sign out everywhere writes its audit row before the session ends', async () => {
    const order: string[] = [];
    api.recordAudit.mockImplementation(async (action: string) => {
      order.push(`audit:${action}`);
      return true;
    });
    fake.state.auth.signOut.mockImplementation(async (opts?: unknown) => {
      order.push(`signOut:${(opts as { scope: string }).scope}`);
      return { error: null };
    });
    wrap(<SecuritySection />);
    fireEvent.click(screen.getByRole('button', { name: /Sign out everywhere/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(order).toEqual(['audit:sign_out_all_devices', 'signOut:global']));
  });
});
