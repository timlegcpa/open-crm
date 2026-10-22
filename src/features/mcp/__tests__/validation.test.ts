// The connector's pure input checks (supabase/functions/mcp-crm/validation.ts), and the
// tool handlers' refusals that happen before any database call.
import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_CREATABLE,
  CONTACT_TIERS,
  CONTACT_UPDATABLE,
  EMAIL_MAX_LEN,
  KEY_RE,
  MAX_AMOUNT,
  MAX_REQUEST_ITEMS,
  BOARD_NOTE_MAX,
  WORK_ITEM_TITLE_MAX,
  normalizeEmail,
  optionalId,
  parseBoardDate,
  parseBoardNote,
  parseCardTitle,
  parseRequestItems,
  parseRequestText,
  pickFrom,
  validateAmount,
  validateContactPatch,
} from '../../../../supabase/functions/mcp-crm/validation';
import { callTool, toolCatalog, TOOLS, type ToolContext } from '../../../../supabase/functions/mcp-crm/tools';
import { createReviewSigner } from '../../../../supabase/functions/mcp-crm/review-token';
import { isUuid } from '../../../../supabase/functions/_shared/http';
import { CLIENT_TIERS } from '../../crm/lib/tiers';

const ID = 'a3bb189e-8bf9-4888-9912-ace4e6543002';

describe('pickFrom', () => {
  it('iterates the allowlist, so an unknown key never lands', () => {
    const input = { first_name: 'Ada', status: 'client', client_since: '2020-01-01', email: 'a@example.com', __proto__: { phone: 'x' } };
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

describe('the tier list', () => {
  it('is the CRM’s own tier list, in order', () => {
    expect([...CONTACT_TIERS]).toEqual([...CLIENT_TIERS]);
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

  it('holds the spouse address and the tier to a shape, and lets an empty one clear', () => {
    expect(validateContactPatch({ spouse_email: 'nope' })).toMatch(/spouse_email is not a valid address/);
    expect(validateContactPatch({ tier: 'F' })).toMatch(/tier must be one of: S, A, B, C, D, E/);
    expect(validateContactPatch({ spouse_email: '', tier: '' })).toBeNull();
    for (const tier of CONTACT_TIERS) expect(validateContactPatch({ tier })).toBeNull();
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

const VOCAB = {
  statuses: ['new_lead', 'client', 'esign_signer'],
  selectable_statuses: [{ key: 'new_lead', label: 'New' }, { key: 'client', label: 'Client' }],
  lead_sources: ['referral', 'other'],
  organization_types: ['llc'], service_types: ['retainer'],
  request_categories: ['general', 'contract'], request_tags: ['general'],
  board_stages: [{ key: 'todo', label: 'To do' }, { key: 'doing', label: 'In progress' }],
  work_item_types: ['task'],
};

describe('the board inputs', () => {
  it('parseBoardDate takes a real calendar day or null, and nothing else', () => {
    expect(parseBoardDate('2027-04-15')).toEqual({ date: '2027-04-15' });
    expect(parseBoardDate(null)).toEqual({ date: null });
    // Each matches nothing a ::date cast would accept, or is outside the bound.
    for (const v of ['2027-02-30', '2027-13-01', '4/15/2027', '', 20270415, '1999-12-31', '2101-01-01', undefined]) {
      expect([v, 'error' in parseBoardDate(v)]).toEqual([v, true]);
    }
  });

  it('parseBoardNote trims, requires text and holds the history note cap', () => {
    expect(parseBoardNote('  called them  ')).toEqual({ note: 'called them' });
    expect(parseBoardNote('x'.repeat(BOARD_NOTE_MAX))).toEqual({ note: 'x'.repeat(BOARD_NOTE_MAX) });
    for (const v of ['   ', undefined, 5, 'x'.repeat(BOARD_NOTE_MAX + 1)]) expect('error' in parseBoardNote(v)).toBe(true);
    expect(parseBoardNote('', 'reason')).toEqual({ error: 'reason is required.' });
  });

  it('parseCardTitle trims, requires text and holds the title bound', () => {
    expect(parseCardTitle(' Call back ')).toEqual({ title: 'Call back' });
    for (const v of [' ', null, 7, 'x'.repeat(WORK_ITEM_TITLE_MAX + 1)]) expect('error' in parseCardTitle(v)).toBe(true);
  });
});

describe('the tool handlers refuse bad input before any database call', () => {
  /** The calls made, less the refusal records: send, remind and delete record each refusal and touch nothing else. */
  const acting = (rpc: ReturnType<typeof vi.fn>) =>
    rpc.mock.calls.filter(([fn, params]) => !(fn === 'mcp_audit_row' && (params as { p_details: { outcome?: string } }).p_details.outcome === 'refused'));
  function ctx(): ToolContext & { rpc: ReturnType<typeof vi.fn>; outwardCalls: ReturnType<typeof vi.fn> } {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const outwardCalls = vi.fn(async () => {
      throw new Error('no outward call expected');
    });
    return {
      rpc,
      outwardCalls,
      db: { rpc },
      privileged: { openAnswer: outwardCalls, readDocument: outwardCalls, setSignInEmail: outwardCalls },
      actor: ID,
      ip: null,
      userAgent: null,
      vocabulary: async () => VOCAB,
      budget: { sends: 0 },
      review: createReviewSigner('test-review-secret-0123456789abcdef'),
      outward: { send: outwardCalls, remind: outwardCalls, receipt: outwardCalls, alert: outwardCalls },
      log: { error() {}, warn() {}, info() {} },
    };
  }

  const ITEM = { label: 'Signed contract' };
  const TOKEN = 'a'.repeat(32);
  const OUTWARD = { list_id: ID, contact_id: ID, review_token: TOKEN, confirmed_with_user: true };

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
    ['create_contact', { email: '  ', phone: '' }],
    ['create_contact', { phone: 5551234 }],
    ['create_contact', { phone: '555 0100', status: 'esign_signer' }],
    ['create_contact', { phone: '555 0100', status: 'made_up' }],
    ['create_contact', { phone: '555 0100', source: 'made_up' }],
    ['create_contact', { phone: '555 0100', source: 7 }],
    ['set_contact_status', { contact_id: 'nope', status: 'client', expected_status: 'new_lead' }],
    ['set_contact_status', { contact_id: ID, status: 'esign_signer', expected_status: 'new_lead' }],
    ['set_contact_status', { contact_id: ID, status: 'client' }],
    ['set_contact_status', { contact_id: ID, status: 'client', expected_status: 'whatever it was' }],
    ['list_board', { stage: 'made_up' }],
    ['list_board', { contact_id: '' }],
    ['create_work_item', { title: '  ' }],
    ['create_work_item', { title: 'x'.repeat(201) }],
    ['create_work_item', { title: 'T', stage: 'made_up' }],
    ['create_work_item', { title: 'T', priority: 'high' }],
    ['create_work_item', { title: 'T', work_item_type: 'made_up' }],
    ['create_work_item', { title: 'T', due_date: '2027-02-30' }],
    ['create_work_item', { title: 'T', contact_id: 'nope' }],
    ['update_work_item', { work_item_id: ID }],
    ['update_work_item', { work_item_id: ID, stage: 'doing' }],
    ['update_work_item', { work_item_id: ID, title: '' }],
    ['update_work_item', { work_item_id: ID, contact_id: '' }],
    ['update_work_item', { work_item_id: ID, due_date: '15/04/2027' }],
    ['update_work_item', { work_item_id: 'nope', title: 'T' }],
    ['move_work_item', { work_item_id: ID, to_stage: 'doing', expected_stage: 'todo' }],
    ['move_work_item', { work_item_id: ID, to_stage: 'doing', expected_stage: 'todo', reason: 'x'.repeat(2001) }],
    ['move_work_item', { work_item_id: ID, to_stage: 'made_up', expected_stage: 'todo', reason: 'r' }],
    ['move_work_item', { work_item_id: ID, to_stage: 'doing', reason: 'r' }],
    ['add_work_item_note', { work_item_id: ID, note: '  ' }],
    ['add_work_item_note', { work_item_id: 'nope', note: 'n' }],
    ['close_request', { list_id: ID, contact_id: ID }],
    ['close_request', { list_id: ID, contact_id: ID, confirmed_with_user: 'true' }],
    ['close_request', { list_id: 'nope', contact_id: ID, confirmed_with_user: true }],
    ['accept_request', { list_id: ID, contact_id: ID, confirmed_with_user: 1 }],
    ['accept_request', { list_id: ID, contact_id: { a: 1 }, confirmed_with_user: true }],
    ['set_request_reminders', { list_id: ID, contact_id: ID, paused: 'true' }],
    ['set_request_reminders', { list_id: ID, contact_id: ID }],
    ['create_contact', { email: 'not-an-email' }],
    ['create_contact', { email: 'a@example.com', first_name: 7 }],
    ['update_contact', { contact_id: ID }],
    ['update_contact', { contact_id: ID, phone: '1', email: 'a@example.com' }],
    ['update_contact', { contact_id: ID, phone: '1', spouse_email: 'not-an-address' }],
    ['update_contact', { contact_id: ID, tier: 'F' }],
    ['update_contact', { contact_id: ID, source: null }],
    ['update_contact', { contact_id: ID, source: 'made_up' }],
    ['update_contact', { contact_id: ID, first_name: 7 }],
    ['update_note', { contact_id: ID, note_id: ID }],
    ['update_note', { contact_id: ID, note_id: ID, body: '   ' }],
    ['update_note', { contact_id: ID, note_id: ID, kind: 'sms' }],
    ['update_note', { contact_id: ID, note_id: ID, body: 'x'.repeat(10_001) }],
    ['update_note', { contact_id: ID, note_id: 'nope', body: 'x' }],
    ['delete_note', { contact_id: ID, note_id: ID }],
    ['delete_note', { contact_id: ID, note_id: ID, confirmed_with_user: 'true' }],
    ['accept_quote', { contact_id: ID, quote_id: ID, service_type: 'retainer' }],
    ['accept_quote', { contact_id: ID, quote_id: ID, service_type: 'Retainer!', confirmed_with_user: true }],
    ['accept_quote', { contact_id: ID, quote_id: ID, service_type: 'retainer', organization_id: '', confirmed_with_user: true }],
    ['change_portal_email', { portal_account_id: ID, new_email: 'a@example.com', confirmed_with_user: true }],
    ['change_portal_email', { portal_account_id: ID, new_email: 'not-an-address', expected_current_email: null, confirmed_with_user: true }],
    ['change_portal_email', { portal_account_id: ID, new_email: 'a@example.com', expected_current_email: null, confirmed_with_user: 1 }],
    ['change_portal_email', { portal_account_id: 'nope', new_email: 'a@example.com', expected_current_email: null, confirmed_with_user: true }],
    ['read_request_answers', { contact_id: ID, list_id: '' }],
    ['list_documents', { contact_id: ID, limit: 0 }],
    ['list_documents', { contact_id: ID, limit: 501 }],
    ['read_document_text', { document_id: 'nope' }],
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
    ['create_request', { contact_id: 'nope', title: 'T', items: [ITEM] }],
    ['create_request', { contact_id: ID, title: '  ', items: [ITEM] }],
    ['create_request', { contact_id: ID, title: 'x'.repeat(201), items: [ITEM] }],
    ['create_request', { contact_id: ID, title: 'T', intro_message: 5, items: [ITEM] }],
    ['create_request', { contact_id: ID, title: 'T', intro_message: 'x'.repeat(5001), items: [ITEM] }],
    ['create_request', { contact_id: ID, title: 'T' }],
    ['create_request', { contact_id: ID, title: 'T', items: [] }],
    ['create_request', { contact_id: ID, title: 'T', items: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, () => ITEM) }],
    ['create_request', { contact_id: ID, title: 'T', items: [{ label: 'x', category: 'made_up' }] }],
    ['create_request', { contact_id: ID, title: 'T', items: [{ label: 'x', kind: 'transaction' }] }],
    ['update_request', { list_id: 'nope', contact_id: ID, review_token: TOKEN, title: 'T', items: [ITEM] }],
    ['update_request', { list_id: ID, contact_id: ID, review_token: TOKEN, title: 'T', items: [{ label: 'x', tag: 'made_up' }] }],
    ['update_request', { list_id: ID, contact_id: ID, title: 'T', items: [ITEM] }],
    ['update_request', { list_id: ID, contact_id: ID, review_token: 'A'.repeat(32), title: 'T', items: [ITEM] }],
    ['list_requests', { contact_id: 'nope' }],
    ['send_request', { ...OUTWARD, review_token: undefined }],
    ['send_request', { ...OUTWARD, review_token: 'A'.repeat(32) }],
    ['send_request', { ...OUTWARD, confirmed_with_user: undefined }],
    ['send_request', { ...OUTWARD, confirmed_with_user: 'true' }],
    ['send_request', { ...OUTWARD, contact_id: '' }],
    ['remind_request', { ...OUTWARD, review_token: 'x' }],
    ['remind_request', { ...OUTWARD, confirmed_with_user: 1 }],
    ['delete_request', { ...OUTWARD, review_token: '' }],
    ['delete_request', { ...OUTWARD, confirmed_with_user: false }],
    ['delete_request', { ...OUTWARD, list_id: { a: 1 } }],
  ])('%s %j', async (name, args) => {
    const c = ctx();
    const result = await callTool(name, args as Record<string, unknown>, c);
    expect(result.isError).toBe(true);
    expect(acting(c.rpc)).toEqual([]);
    // Only the three that record refusals write anything at all.
    if (!['send_request', 'remind_request', 'delete_request'].includes(name)) expect(c.rpc).not.toHaveBeenCalled();
    expect(c.outwardCalls).not.toHaveBeenCalled();
  });

  it.each(['send_request', 'remind_request'])('%s checks the spent send budget before anything else', async (name) => {
    const c = ctx();
    c.budget.sends = 1;
    const result = await callTool(name, { list_id: 'nope' }, c);
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/^Only one email to a contact can go out per call/) }] });
    // Recorded, with no id: 'nope' is not one.
    expect(c.rpc.mock.calls).toEqual([['mcp_audit_row', expect.objectContaining({ p_action: `mcp_${name}`, p_details: { outcome: 'refused', reason: 'budget' } })]]);
  });

  it('create_request sends the validated items, never a status', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { id: ID, status: 'draft', item_count: 1 }, error: null });
    await callTool('create_request', { contact_id: ID, title: ' Onboarding ', intro_message: '  ', items: [{ label: ' Contract ', category: 'contract', status: 'sent' }], status: 'sent' }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_create_request', {
      p_contact_id: ID, p_title: 'Onboarding', p_intro: null,
      p_items: [{ kind: 'document', label: 'Contract', description: null, required: true, sensitive: false, category: 'contract', tag: 'general', sort_order: 0 }],
      p_actor: ID, p_ip: null, p_user_agent: null,
    });
  });

  it('create takes a phone alone, and a blank address is an absent one', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'created', id: ID }, error: null });
    await callTool('create_contact', { email: '', phone: ' 555 0100 ', status: 'client', source: 'referral' }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_create_contact', expect.objectContaining({
      p_patch: { phone: '555 0100', status: 'client', source: 'referral' },
    }));
  });

  it('a stage move passes the stage read back, and the new stage, through unchanged', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'system_status', current_status: 'esign_signer' }, error: null });
    const res = await callTool('set_contact_status', { contact_id: ID, status: 'client', expected_status: 'esign_signer' }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_set_contact_status', expect.objectContaining({ p_status: 'client', p_expected_status: 'esign_signer' }));
    expect(res.isError).toBe(true);
  });

  it('update_work_item writes only what is present: an explicit null clears, an absent key is left', async () => {
    const c = ctx();
    c.rpc.mockResolvedValueOnce({ data: { outcome: 'updated', card: { id: ID } }, error: null });
    await callTool('update_work_item', { work_item_id: ID, contact_id: null, due_date: null, priority: 'low' }, c);
    expect(c.rpc).toHaveBeenCalledWith('mcp_update_work_item', expect.objectContaining({
      p_id: ID, p_patch: { contact_id: null, due_date: null, priority: 'low' },
    }));
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
  it('fills the pick lists and leaves the static catalog untouched', () => {
    const vocab = { ...VOCAB, statuses: ['a'], organization_types: ['b'], service_types: ['c'], request_categories: ['d'], request_tags: ['e'] };
    const catalog = toolCatalog(vocab) as typeof TOOLS;
    type Props = Record<string, { enum?: unknown; items?: { properties: Record<string, { enum?: unknown }> } }>;
    const prop = (tools: typeof TOOLS, tool: string, p: string) => (tools.find((t) => t.name === tool)!.inputSchema.properties as unknown as Props)[p];
    expect(prop(catalog, 'search_contacts', 'status').enum).toEqual(['a']);
    expect(prop(catalog, 'add_business', 'organization_type').enum).toEqual(['b']);
    expect(prop(catalog, 'upsert_quote', 'service_type').enum).toEqual(['c']);
    for (const tool of ['create_request', 'update_request']) {
      expect(prop(catalog, tool, 'items').items!.properties.category.enum).toEqual(['d']);
      expect(prop(catalog, tool, 'items').items!.properties.tag.enum).toEqual(['e']);
    }
    expect(prop(catalog, 'create_contact', 'status').enum).toEqual(['new_lead', 'client']);
    expect(prop(catalog, 'create_contact', 'source').enum).toEqual(['referral', 'other']);
    expect(prop(catalog, 'set_contact_status', 'status').enum).toEqual(['new_lead', 'client']);
    expect(prop(catalog, 'set_contact_status', 'expected_status').enum).toEqual(['a']);
    for (const [tool, p] of [['list_board', 'stage'], ['create_work_item', 'stage'], ['move_work_item', 'to_stage'], ['move_work_item', 'expected_stage']]) {
      expect(prop(catalog, tool, p).enum).toEqual(['todo', 'doing']);
    }
    expect(prop(catalog, 'update_work_item', 'work_item_type').enum).toEqual(['task']);
    // The owner's labels travel with the keys, so a lane is never picked by a guessed name.
    const described = (tools: typeof TOOLS, tool: string) => tools.find((t) => t.name === tool)!.description;
    for (const tool of ['list_board', 'create_work_item', 'move_work_item']) expect(described(catalog, tool)).toContain('todo = To do, doing = In progress');
    expect(described(catalog, 'set_contact_status')).toContain('new_lead = New, client = Client');
    expect(described(TOOLS, 'move_work_item')).not.toContain('doing = In progress');
    expect(prop(TOOLS, 'upsert_quote', 'service_type').enum).toBeUndefined();
    expect(prop(TOOLS, 'create_request', 'items').items!.properties.category.enum).toBeUndefined();
  });
});

describe('parseRequestItems', () => {
  const keys = { categories: ['general', 'contract'], tags: ['general', 'business'] };

  it('fills the defaults, trims, and numbers the items in order', () => {
    expect(parseRequestItems([{ label: ' A ' }, { label: 'B', kind: 'question', required: false, sensitive: true, description: ' why ', category: 'contract', tag: 'business' }], keys)).toEqual({
      items: [
        { kind: 'document', label: 'A', description: null, required: true, sensitive: false, category: 'general', tag: 'general', sort_order: 0 },
        { kind: 'question', label: 'B', description: 'why', required: false, sensitive: true, category: 'contract', tag: 'business', sort_order: 1 },
      ],
    });
  });

  it('reads an explicit null as omitted', () => {
    const out = parseRequestItems([{ label: 'A', kind: null, required: null, sensitive: null, category: null, tag: null, description: null }], keys);
    expect(out).toEqual({ items: [{ kind: 'document', label: 'A', description: null, required: true, sensitive: false, category: 'general', tag: 'general', sort_order: 0 }] });
  });

  it.each([
    [[{ label: 'A', required: 'false' }], /required must be true or false/],
    [[{ label: 'A', sensitive: 'yes' }], /sensitive must be true or false/],
    [[{ label: 'A', kind: 'transaction' }], /kind must be one of/],
    [[{ label: 'A', category: 'made_up' }], /category must be one of: general, contract/],
    [[{ label: 'A', tag: 7 }], /tag must be one of/],
    [[{ label: 'A', sensitive: true }], /Item 1 cannot be sensitive with kind 'document'/],
    [[{ label: 'A', description: 5 }], /description must be text/],
    [[{ label: 'A', description: 'x'.repeat(2001) }], /description must be 2000/],
    [[{ label: 'x'.repeat(501) }], /label must be 500/],
    [[{ label: '   ' }], /Item 1 needs a label/],
    [['A'], /Item 1 must be an object/],
    [[{ label: 'A' }, null], /Item 2 must be an object/],
    [[], /at least one item/],
    ['A', /at least one item/],
  ])('refuses %j instead of coercing it', (raw, message) => {
    const out = parseRequestItems(raw, keys);
    expect('error' in out && out.error).toMatch(message);
  });

  it('holds the item count bound', () => {
    expect(parseRequestItems(Array.from({ length: MAX_REQUEST_ITEMS }, () => ({ label: 'A' })), keys)).toHaveProperty('items');
    expect(parseRequestItems(Array.from({ length: MAX_REQUEST_ITEMS + 1 }, () => ({ label: 'A' })), keys)).toHaveProperty('error');
  });
});

describe('parseRequestText', () => {
  it('trims, and reads a blank or absent intro as none', () => {
    expect(parseRequestText(' T ', undefined)).toEqual({ title: 'T', intro: null });
    expect(parseRequestText('T', null)).toEqual({ title: 'T', intro: null });
    expect(parseRequestText('T', ' \n ')).toEqual({ title: 'T', intro: null });
    expect(parseRequestText('T', ' Hi ')).toEqual({ title: 'T', intro: 'Hi' });
  });

  it('refuses a missing, blank or long title and a long or non-text intro', () => {
    for (const [title, intro] of [[undefined, null], ['  ', null], ['x'.repeat(201), null], ['T', 1], ['T', 'x'.repeat(5001)]]) {
      expect(parseRequestText(title, intro)).toHaveProperty('error');
    }
  });
});
