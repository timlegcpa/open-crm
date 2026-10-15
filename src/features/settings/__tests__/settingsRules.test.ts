import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// recordAudit writes through the app's client; this stand-in records the inserts.
const fake = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  session: { user: { id: '00000000-0000-4000-8000-000000000001' } } as { user: { id: string } } | null,
}));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: fake.session } }) },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        fake.inserts.push({ table, row });
        return { error: null };
      },
    }),
  }),
}));

import { emailDomain, keyFromLabel, recordAudit } from '../api';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from '@/lib/passwordRules';
import { readRecoveryHash, resetErrorMessage } from '../public/authRest';
import { browserName } from '../SecuritySection';
import { identityProblem } from '../IdentitySection';

describe('password rules', () => {
  it('equal the Auth settings in supabase/config.toml', () => {
    const toml = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
    expect(toml).toMatch(new RegExp(`^minimum_password_length = ${MIN_PASSWORD_LENGTH}$`, 'm'));
    expect(toml).toMatch(/^password_requirements = "lower_upper_letters_digits_symbols"$/m);
  });

  it('names the first rule a password breaks', () => {
    expect(passwordProblem('Ab1!')).toMatch(/at least 8/);
    expect(passwordProblem('abcdefg1!')).toMatch(/uppercase/);
    expect(passwordProblem('ABCDEFG1!')).toMatch(/lowercase/);
    expect(passwordProblem('Abcdefgh!')).toMatch(/digit/);
    expect(passwordProblem('Abcdefgh1')).toMatch(/symbol/);
    expect(passwordProblem(`Aa1!${'x'.repeat(MAX_PASSWORD_BYTES - 4)}`)).toBeNull();
    expect(passwordProblem(`Aa1!${'x'.repeat(MAX_PASSWORD_BYTES - 3)}`)).toMatch(/at most 72 bytes; accented letters and emoji count as more than one/);
    // 34 two-byte letters plus four ASCII is 72 bytes and allowed; 36 is 76 bytes and refused.
    expect(passwordProblem(`Aa1!${'é'.repeat(34)}`)).toBeNull();
    expect(passwordProblem(`Aa1!${'\u00e9'.repeat(36)}`)).toMatch(/at most 72 bytes/);
    expect(passwordProblem('Abcdefg1!')).toBeNull();
  });

  it('allows spaces and printable Unicode, refuses only control characters, and counts only ASCII punctuation as a symbol', () => {
    expect(passwordProblem('Abc def1!')).toBeNull();
    expect(passwordProblem('Abc déf1! ✓')).toBeNull();
    expect(passwordProblem('correct Horse 9 battery!')).toBeNull();
    for (const control of ['\t', '\n', '\r', '\u0000', '\u007f', '\u0085']) {
      expect(passwordProblem(`Abcdefg1!${control}`), JSON.stringify(control)).toMatch(/control characters/);
    }
    expect(passwordProblem('Abcdefg1 ')).toMatch(/symbol/);
    expect(passwordProblem('Abcdefg1é')).toMatch(/symbol/);
    expect(passwordProblem('Abcdefg1x')).toMatch(/symbol/);
    for (const symbol of ['!', '/', ':', '@', '[', '`', '{', '~']) expect(passwordProblem(`Abcdefg1${symbol}`)).toBeNull();
  });
});

describe('recordAudit', () => {
  beforeEach(() => {
    fake.inserts.length = 0;
    fake.session = { user: { id: '00000000-0000-4000-8000-000000000001' } };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('writes a lowercase action with ids and codes', async () => {
    expect(await recordAudit('settings_update', { section: 'identity' })).toBe(true);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({
      table: 'audit_logs',
      row: { action: 'settings_update', details: { section: 'identity' }, user_id: '00000000-0000-4000-8000-000000000001' },
    });
  });

  it('refuses an action that breaks the rule, and never throws', async () => {
    for (const action of ['2fa_enabled', 'Settings_update', 'settings update', '', 'a'.repeat(101)]) {
      expect(await recordAudit(action)).toBe(false);
    }
    expect(fake.inserts).toEqual([]);
  });

  it('refuses free text in the details', async () => {
    expect(await recordAudit('settings_update', { note: 'Ada Lovelace asked for this' })).toBe(false);
    expect(fake.inserts).toEqual([]);
  });

  it('writes nothing without a session', async () => {
    fake.session = null;
    expect(await recordAudit('settings_update')).toBe(false);
    expect(fake.inserts).toEqual([]);
  });
});

describe('small helpers', () => {
  it('emailDomain keeps only a plain lowercase domain', () => {
    expect(emailDomain('Ada@Example.COM')).toBe('example.com');
    expect(emailDomain('ada@')).toBeNull();
    expect(emailDomain('ada@exa mple.com')).toBeNull();
    expect(emailDomain('ada@123')).toBeNull();
  });

  it('keyFromLabel makes a stable lowercase key, or none', () => {
    expect(keyFromLabel('Trade show')).toBe('trade_show');
    expect(keyFromLabel('  Café referral!  ')).toBe('cafe_referral');
    expect(keyFromLabel('2024 Expo')).toBe('expo');
    expect(keyFromLabel('123')).toBeNull();
    expect(keyFromLabel('x'.repeat(50))).toHaveLength(40);
  });

  it('browserName checks the specific names before Chrome and Safari', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    expect(browserName(`${chrome} Edg/130.0`)).toBe('Edge');
    expect(browserName(`${chrome} OPR/115.0`)).toBe('Opera');
    expect(browserName('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0')).toBe('Firefox');
    expect(browserName(chrome)).toBe('Chrome');
    expect(browserName('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari');
    expect(browserName('')).toBe('This browser');
  });

  it('identityProblem requires a name and a hex colour', () => {
    const draft = { display_name: 'Acme LLC', legal_name: '', sender_name: '', postal_address: '', primary_color: '' };
    expect(identityProblem(draft)).toBeNull();
    expect(identityProblem({ ...draft, display_name: '  ' })).toMatch(/required/);
    expect(identityProblem({ ...draft, primary_color: 'blue' })).toMatch(/six hex digits/);
    expect(identityProblem({ ...draft, primary_color: '#1F6FEB' })).toBeNull();
    expect(identityProblem({ ...draft, legal_name: 'x'.repeat(201) })).toMatch(/200/);
  });
});

describe('password recovery link', () => {
  it('takes a recovery token and nothing else', () => {
    expect(readRecoveryHash('#access_token=abc&type=recovery&expires_in=3600')).toEqual({ token: 'abc', error: null });
    expect(readRecoveryHash('#access_token=abc&type=signup')).toEqual({ token: null, error: null });
    expect(readRecoveryHash('#error=access_denied&error_code=otp_expired')).toEqual({ token: null, error: 'otp_expired' });
    expect(readRecoveryHash('')).toEqual({ token: null, error: null });
  });

  it('says why a change was refused', () => {
    expect(resetErrorMessage(403, 'insufficient_aal')).toMatch(/Two-factor is on/);
    expect(resetErrorMessage(422, 'same_password')).toMatch(/different/);
    expect(resetErrorMessage(401, null)).toMatch(/expired/);
    expect(resetErrorMessage(0, 'network')).toMatch(/reach the server/);
  });
});
