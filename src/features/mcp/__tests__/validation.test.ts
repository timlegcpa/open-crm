// The connector's pure input checks (supabase/functions/mcp-crm/validation.ts), and the
// tool handlers' refusals that happen before any database call.
import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_CREATABLE,
  CONTACT_UPDATABLE,
  EMAIL_MAX_LEN,
  KEY_RE,
  MAX_AMOUNT,
  normalizeEmail,
  optionalId,
  pickFrom,
  validateAmount,
  validateContactPatch,
} from '../../../../supabase/functions/mcp-crm/validation';
import { callTool, toolCatalog, TOOLS, type ToolContext } from '../../../../supabase/functions/mcp-crm/tools';
import { isUuid } from '../../../../supabase/functions/_shared/http';

const ID = 'a3bb189e-8bf9-4888-9912-ace4e6543002';

describe('pickFrom', () => {
  it('iterates the allowlist, so an unknown key never lands', () => {
    const input = { first_name: 'Ada', status: 'client', source: 'mcp', email: 'a@example.com', __proto__: { phone: 'x' } };
    expect(pickFrom(CONTACT_UPDATABLE, input)).toEqual({ first_name: 'Ada' });
  });

  it('treats undefined and null as absent', () => {
    expect(pickFrom(CONTACT_CREATABLE, { email: 'a@example.com', phone: null, last_name: undefined })).toEqual({ email: 'a@example.com' });
  });

  it('an update may not carry an address; creation may', () => {
    expect(CONTACT_UPDATABLE).not.toContain('email');
    expect(CONTACT_CREATABLE).toContain('email');
  });
});

describe('validateContactPatch', () => {
  it('refuses a value that is not a string instead of coercing it', () => {
    expect(validateContactPatch({ first_name: 42 })).toMatch(/must be a string/);
    expect(validateContactPatch({ phone: true })).toMatch(/must be a string/);
  });

  it('caps length and checks the address shape', () => {
    expect(validateContactPatch({ first_name: 'x'.repeat(5001) })).toMatch(/too long/);
    expect(validateContactPatch({ email: 'not-an-email' })).toMatch(/not a valid address/);
    expect(validateContactPatch({ email: 'ada@example.com', first_name: 'Ada' })).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims, and keeps case', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.com\t')).toEqual({ email: 'Ada.Lovelace@Example.com' });
  });

  it.each([undefined, null, 42, { email: 'a@example.com' }, '', '   ', 'no-at-sign', 'a@b', 'a b@example.com', 'a@example.com\r\nBcc: x@example.com'])(
    'refuses %j',
    (v) => {
      expect(normalizeEmail(v)).toHaveProperty('error');
    },
  );

  it('holds the 254-character column bound', () => {
    const at254 = `${'a'.repeat(254 - '@example.com'.length)}@example.com`;
    expect(at254).toHaveLength(EMAIL_MAX_LEN);
    expect(normalizeEmail(at254)).toEqual({ email: at254 });
    expect(normalizeEmail(`a${at254}`)).toHaveProperty('error');
  });
});

describe('validateAmount', () => {
  it.each([0, 1, 99.99, 1250.5, MAX_AMOUNT])('accepts %s', (v) => {
    expect(validateAmount(v)).toEqual({ amount: v });
  });

  it.each([
    ['a string', '100'],
    ['true', true],
    ['an empty string', ''],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative', -1],
    ['three decimals', 10.005],
    ['past the column', 10_000_000_000_000],
  ])('refuses %s', (_label, v) => {
    expect(validateAmount(v)).toHaveProperty('error');
  });
});

describe('optionalId', () => {
  it('absence (undefined or null) means none; an empty string is an error, not absence', () => {
    expect(optionalId(undefined, isUuid)).toEqual({ id: null });
    expect(optionalId(null, isUuid)).toEqual({ id: null });
    expect(optionalId(ID, isUuid)).toEqual({ id: ID });
    for (const v of ['', 'nope', 0, {}, [ID]]) expect(optionalId(v, isUuid)).toEqual({ error: true });
  });
});

describe('KEY_RE', () => {
  it('matches a pick-list key and nothing that could be a pattern or a path', () => {
    for (const ok of ['retainer', 'annual_plan', 'a1']) expect(KEY_RE.test(ok)).toBe(true);
    for (const bad of ['', 'Retainer', '1st', 'a-b', 'a b', '%', `a${'b'.repeat(40)}`]) expect([bad, KEY_RE.test(bad)]).toEqual([bad, false]);
  });
});

describe('the tool handlers refuse bad input before any database call', () => {
  function ctx(): ToolContext & { rpc: ReturnType<typeof vi.fn> } {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    return {
      rpc,
      db: { rpc },
      actor: ID,
      ip: null,
      userAgent: null,
      vocabulary: async () => ({ statuses: ['new_lead'], organization_types: ['llc'], service_types: ['retainer'] }),
      budget: { sends: 0 },
    };
  }

  it.each([
    ['get_contact', { contact_id: { a: 1 } }],
    ['get_contact', { contact_id: 'nope' }],
    ['search_contacts', { query: 42 }],
    ['search_contacts', { query: 'x'.repeat(201) }],
    ['search_contacts', { status: 'made_up' }],
    ['search_contacts', { limit: 1e100 }],
    ['search_contacts', { limit: 0 }],
    ['search_contacts', { limit: 2.5 }],
    ['search_contacts', { limit: '5' }],
    ['create_contact', {}],
    ['create_contact', { email: 'not-an-email' }],
    ['create_contact', { email: 'a@example.com', first_name: 7 }],
    ['update_contact', { contact_id: ID }],
    ['update_contact', { contact_id: ID, phone: '1', email: 'a@example.com' }],
    ['update_contact', { contact_id: ID, phone: '1', spouse_email: 'a@example.com' }],
    ['correct_contact_email', { contact_id: ID, email: 'a@example.com' }],
    ['correct_contact_email', { contact_id: ID, email: 'a@example.com', expected_current_email: 5 }],
    ['correct_contact_email', { contact_id: ID, email: 'a@example.com', expected_current_email: null }],
    ['correct_contact_email', { contact_id: ID, email: 'a@example.com', expected_current_email: null, confirmed_with_user: 'true' }],
    ['add_business', { contact_id: ID, name: '  ', organization_type: 'llc' }],
    ['add_business', { contact_id: ID, name: 'Acme LLC', organization_type: 'made_up' }],
    ['log_call_note', { contact_id: ID, body: '' }],
    ['log_call_note', { contact_id: ID, body: 'x', kind: 'sms' }],
    ['log_call_note', { contact_id: ID, body: 'x'.repeat(10_001) }],
    ['upsert_quote', { contact_id: ID, service_type: 'made_up', cadence: 'monthly', amount: 1 }],
    ['upsert_quote', { contact_id: ID, service_type: 'retainer', cadence: 'weekly', amount: 1 }],
    ['upsert_quote', { contact_id: ID, service_type: 'retainer', cadence: 'monthly', amount: '1' }],
    ['upsert_quote', { contact_id: ID, service_type: 'retainer', cadence: 'monthly', amount: 1, organization_id: '' }],
    ['delete_quote', { contact_id: ID, quote_id: ID, service_type: 'retainer' }],
    ['delete_quote', { contact_id: ID, quote_id: ID, service_type: 'retainer', confirmed_with_user: 'true' }],
    ['delete_quote', { contact_id: ID, quote_id: ID, service_type: 'Retainer!', confirmed_with_user: true }],
    ['delete_quote', { contact_id: ID, quote_id: ID, service_type: 'retainer', organization_id: '', confirmed_with_user: true }],
  ])('%s %j', async (name, args) => {
    const c = ctx();
    const result = await callTool(name, args as Record<string, unknown>, c);
    expect(result.isError).toBe(true);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('create normalizes before validating: a padded valid address is accepted, trimmed', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'created', id: ID }, error: null });
    await callTool('create_contact', { email: '  ada@example.com ' }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_create_contact', expect.objectContaining({ p_patch: { email: 'ada@example.com' }, p_actor: ID }));
  });

  it('correct_contact_email passes the expected address through untouched; the database canonicalizes both sides', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'updated', id: ID }, error: null });
    await callTool('correct_contact_email', { contact_id: ID, email: 'b@example.com', expected_current_email: '\tA@Example.com ', confirmed_with_user: true }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_correct_contact_email', expect.objectContaining({ p_expected_current_email: '\tA@Example.com ' }));
  });

  it('an outcome the handler does not know throws, never reporting success', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'surprise' }, error: null });
    await expect(callTool('correct_contact_email', { contact_id: ID, email: 'b@example.com', expected_current_email: null, confirmed_with_user: true }, c)).rejects.toThrow(/unknown outcome/);
  });

  it('a database error that is not a known refusal is thrown, never echoed', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: null, error: { message: 'detail 0451' } });
    await expect(callTool('log_call_note', { contact_id: ID, body: 'x' }, c)).rejects.toMatchObject({ message: 'detail 0451' });
  });
});

describe('toolCatalog', () => {
  it('fills the three pick lists and leaves the static catalog untouched', () => {
    const vocab = { statuses: ['a'], organization_types: ['b'], service_types: ['c'] };
    const catalog = toolCatalog(vocab) as typeof TOOLS;
    const prop = (tools: typeof TOOLS, tool: string, p: string) =>
      (tools.find((t) => t.name === tool)!.inputSchema.properties as unknown as Record<string, { enum?: unknown }>)[p];
    expect(prop(catalog, 'search_contacts', 'status').enum).toEqual(['a']);
    expect(prop(catalog, 'add_business', 'organization_type').enum).toEqual(['b']);
    expect(prop(catalog, 'upsert_quote', 'service_type').enum).toEqual(['c']);
    expect(prop(TOOLS, 'upsert_quote', 'service_type').enum).toBeUndefined();
  });
});
