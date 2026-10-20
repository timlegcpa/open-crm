import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contact, ContactService } from '@/api/contacts';
import { PIPELINE_STATUSES, SELECTABLE_STATUSES, STORED_STATUSES } from '@/lib/contactStatus';
import { parseCsv, toCsv } from '@/lib/csv';
import { activityAfter, flattenActivity } from '../api';
import { ACTIVITY_CATALOG, describeActivity } from '@/lib/activityCatalog';
import {
  cadenceText,
  contactIdsForView,
  LEAD_GROUPS,
  leadPipeline,
  matchesCrmSearch,
  mrrArrText,
  pipelineFigures,
  toAmount,
  unsignedWork,
  viewLabel,
  yearlyOfLine,
} from '../lib/board';
import { contactCsvRows } from '../lib/csv';
import { intakeQuotes } from '../lib/intake';
import { isTypingContext, moveForDrop } from '../lib/interaction';
import { allowedOrganizationStatusTargets, findOrganizationNameClash } from '../lib/organizations';
import { contactPatchForQuoteChange, parseCurrencyInput, statusChangePatch } from '../lib/quotes';
import {
  addedAt,
  bucketBySection,
  contactRowName,
  CRM_LISTS,
  CRM_SECTIONS,
  CRM_TABS,
  isCrmTabKey,
  mergeClientSections,
  resolveCrmTab,
  statusesWithoutSection,
  statusInList,
} from '../lib/sections';
import { addedCutoff, crmTableMrrTotal, crmTableRows, DEFAULT_CRM_TABLE_FILTERS } from '../lib/table';

let seq = 0;
function quote(extra: Partial<ContactService> = {}): ContactService {
  seq += 1;
  return {
    id: `q${seq}`,
    contact_id: 'c',
    organization_id: null,
    service_type: 'retainer',
    state: 'proposed',
    cadence: 'monthly',
    amount: '100.00',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function contact(id: string, extra: Partial<Contact> = {}): Contact {
  return {
    id,
    created_at: '2026-01-01T12:00:00Z',
    updated_at: '2026-01-01T12:00:00Z',
    submitted_at: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: null,
    business_name: null,
    status: 'new_lead',
    source: 'other',
    spouse_first_name: null,
    spouse_last_name: null,
    spouse_name: null,
    spouse_email: null,
    spouse_phone: null,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    client_since: null,
    tier: null,
    archived_at: null,
    contact_services: [],
    ...extra,
  };
}

const SOURCES = { serviceLabels: new Map([['retainer', 'Retainer']]), organizations: [] };

describe('sections', () => {
  it('every stored status belongs to exactly one section, so no contact can vanish', () => {
    expect(statusesWithoutSection()).toEqual([]);
    const held = CRM_SECTIONS.map((s) => s.status);
    expect(new Set(held).size).toBe(held.length);
    expect([...held].sort()).toEqual([...STORED_STATUSES].sort());
  });

  it('the Leads list is the pipeline and Clients holds paying contacts only', () => {
    expect(CRM_LISTS.find((l) => l.key === 'leads')!.statuses).toEqual([...PIPELINE_STATUSES]);
    expect(statusInList('client', 'clients')).toBe(true);
    expect(statusInList('former_client', 'clients')).toBe(false);
    expect(statusInList('lost', 'all')).toBe(true);
    expect(statusInList('lost', 'leads')).toBe(false);
    // Active clients (the Tiers tab) are the recurring ones: no one-time clients.
    expect(statusInList('client', 'active')).toBe(true);
    expect(statusInList('one_time', 'active')).toBe(false);
    expect(statusInList('one_time', 'clients')).toBe(true);
  });

  it('sorts client sections A-Z by last name, every other section newest added first', () => {
    const rows = [
      contact('1', { status: 'client', first_name: 'Zed', last_name: 'Adams' }),
      contact('2', { status: 'client', first_name: 'Amy', last_name: 'Young' }),
      contact('3', { created_at: '2026-01-01T00:00:00Z' }),
      contact('4', { created_at: '2025-06-01T00:00:00Z', submitted_at: '2026-02-01T00:00:00Z' }),
    ];
    const sections = bucketBySection(rows);
    expect(sections.find((s) => s.status === 'client')!.rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(sections.find((s) => s.status === 'new_lead')!.rows.map((r) => r.id)).toEqual(['4', '3']);
  });

  it('names a client "Last, First" and anyone else naturally, falling back to the business', () => {
    expect(contactRowName(contact('1', { status: 'client' }))).toBe('Lovelace, Ada');
    expect(contactRowName(contact('1'))).toBe('Ada Lovelace');
    expect(contactRowName(contact('1', { full_name: '', first_name: '', last_name: '', business_name: 'Acme LLC' }))).toBe('Acme LLC');
  });

  it('"Added" is the backdated intake date when there is one', () => {
    expect(addedAt({ submitted_at: '2025-05-05T00:00:00Z', created_at: '2026-01-01T00:00:00Z' })).toBe('2025-05-05T00:00:00Z');
    expect(addedAt({ submitted_at: null, created_at: '2026-01-01T00:00:00Z' })).toBe('2026-01-01T00:00:00Z');
  });
});

describe('board money', () => {
  it('NULL, 0, blank, garbage and negatives are all unpriced; numeric strings parse', () => {
    expect([null, undefined, '', '0', 0, -5, 'abc'].map(toAmount)).toEqual([null, null, null, null, null, null, null]);
    expect(toAmount('1250.50')).toBe(1250.5);
  });

  it('never blends cadences, and ARR is monthly x 12 plus annual with one-time out', () => {
    const [group] = leadPipeline(
      [
        contact('a', {
          contact_services: [
            quote({ cadence: 'monthly', amount: '100' }),
            quote({ cadence: 'annual', amount: '600' }),
            quote({ cadence: 'one_time', amount: '50' }),
            quote({ cadence: 'monthly', amount: null }),
            quote({ cadence: 'quarterly' as ContactService['cadence'], amount: '999' }),
          ],
        }),
      ],
      SOURCES,
    );
    const totals = { monthly: group.monthly, annual: group.annual, oneTime: group.oneTime };
    expect(totals).toEqual({ monthly: 100, annual: 600, oneTime: 50 });
    expect(cadenceText(totals)).toBe('$100/mo · $600/yr · $50 once');
    expect(mrrArrText(totals)).toBe('$100 MRR · $1,800 ARR');
    expect(mrrArrText({ monthly: 0, annual: 1700 })).toBe('$1,700 ARR');
    expect(mrrArrText({ monthly: 0, annual: 0 })).toBe('');
    expect(yearlyOfLine('monthly', '10')).toBe(120);
    expect(yearlyOfLine('one_time', '10')).toBeNull();
  });
});

describe('the pipeline', () => {
  it('has one column per pipeline status, in order', () => {
    expect(LEAD_GROUPS.map((g) => g.status)).toEqual([...PIPELINE_STATUSES]);
  });

  it('orders a column newest added first, never by money, and keeps an empty column', () => {
    const groups = leadPipeline(
      [
        contact('old-rich', { created_at: '2025-01-01T00:00:00Z', contact_services: [quote({ amount: '9999' })] }),
        contact('new-poor', { created_at: '2026-02-01T00:00:00Z' }),
      ],
      SOURCES,
    );
    expect(groups.find((g) => g.status === 'new_lead')!.rows.map((r) => r.contactId)).toEqual(['new-poor', 'old-rich']);
    expect(groups.find((g) => g.status === 'warm')!.rows).toEqual([]);
  });

  it('a lead with no email or phone (whitespace counts as none) is unreachable', () => {
    const [group] = leadPipeline([contact('a', { email: '  ', phone: null })], SOURCES);
    expect(group.rows[0].reachable).toBe(false);
  });

  it('counts proposed lines only on a card, and leaves out lost contacts', () => {
    const groups = leadPipeline(
      [contact('a', { contact_services: [quote({ state: 'accepted', amount: '50' }), quote({ amount: '10' })] }), contact('b', { status: 'lost' })],
      SOURCES,
    );
    expect(groups[0].monthly).toBe(10);
    expect(groups.flatMap((g) => g.rows).map((r) => r.contactId)).toEqual(['a']);
  });

  it('the top bar figures are open leads and cold contacts with quotes; clients are not pipeline', () => {
    const figures = pipelineFigures(
      unsignedWork(
        [
          contact('lead', { status: 'hot', contact_services: [quote({ amount: '100' })] }),
          contact('cold', { status: 'cold', contact_services: [quote({ cadence: 'annual', amount: '900' })] }),
          contact('client', { status: 'client', contact_services: [quote({ amount: '5000' })] }),
          contact('lost', { status: 'lost', contact_services: [quote({ amount: '7' })] }),
        ],
        SOURCES,
      ),
    );
    expect(figures.map((f) => [f.label, f.people, f.monthly, f.annual])).toEqual([
      ['Leads quoted', 1, 100, 0],
      ['Cold', 1, 0, 900],
    ]);
  });

  it('a view resolves to its people; an unknown view filters nothing', () => {
    const rows = [contact('a', { status: 'hot' }), contact('b', { status: 'cold', contact_services: [quote()] })];
    expect(contactIdsForView('leads_hot', rows, SOURCES)).toEqual(new Set(['a']));
    expect(contactIdsForView('unsigned_parked', rows, SOURCES)).toEqual(new Set(['b']));
    expect(contactIdsForView('nonsense', rows, SOURCES)).toBeNull();
    expect(contactIdsForView(null, rows, SOURCES)).toBeNull();
    expect(viewLabel('leads_hot', (s) => (s === 'hot' ? 'Hot' : s))).toBe('Hot');
    expect(viewLabel('nonsense', (s) => s)).toBeNull();
  });
});

describe('the CRM search', () => {
  const org = { id: 'o', contact_id: 'a', name: 'Acme LLC', organization_type: 'llc' };
  it('an empty query matches everyone', () => {
    expect(matchesCrmSearch(contact('a'), [], '  ')).toBe(true);
  });
  it('reaches the spouse, organizations by name, and a spouse phone by four or more digits', () => {
    expect(matchesCrmSearch(contact('a', { spouse_first_name: 'Charles' }), [], 'charl')).toBe(true);
    expect(matchesCrmSearch(contact('a'), [org], 'acme')).toBe(true);
    expect(matchesCrmSearch(contact('a', { spouse_phone: '(555) 010-7788' }), [], '0107788')).toBe(true);
  });
});

describe('status order comes from the database', () => {
  const order = new Map([
    ['hot', { sort_order: 1 }],
    ['new_lead', { sort_order: 2 }],
  ]);
  it('sections follow sort_order, and statuses it does not list keep code order after them', () => {
    const sections = bucketBySection([], order).map((s) => s.status);
    expect(sections.slice(0, 3)).toEqual(['hot', 'new_lead', 'active_lead']);
    expect(bucketBySection([]).map((s) => s.status)).toEqual(CRM_SECTIONS.map((s) => s.status));
  });
  it('board columns follow sort_order', () => {
    expect(leadPipeline([], { ...SOURCES, statusOrder: order }).map((g) => g.status)).toEqual(['hot', 'new_lead', 'active_lead', 'warm', 'cold']);
  });
});

describe('activity paging', () => {
  it('the next page is strictly older by (created_at, id), quoted for PostgREST', () => {
    expect(activityAfter({ created_at: '2026-03-04T10:00:00+00:00', id: 'r9' })).toBe(
      'created_at.lt."2026-03-04T10:00:00+00:00",and(created_at.eq."2026-03-04T10:00:00+00:00",id.lt."r9")',
    );
  });
  it('a row seen on an earlier page is shown once', () => {
    const row = (id: string) => ({ id, contact_id: 'c', action: 'profile_view', details: null, created_at: '2026-01-01T00:00:00Z' });
    expect(flattenActivity([[row('a'), row('b')], [row('b'), row('c')]]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the table', () => {
  const today = new Date(2026, 2, 1);
  it('twelve months is a calendar year back, not 365 days', () => {
    expect(addedCutoff('12m', new Date(2024, 1, 29))).toBe('2023-02-28');
    expect(addedCutoff('30', today)).toBe('2026-01-30');
    expect(addedCutoff('any', today)).toBeNull();
  });

  it('every sort breaks a tie by name, and the MRR total adds nothing for a no-value cell', () => {
    const rows = [
      contact('1', { first_name: 'B', last_name: 'Same' }),
      contact('2', { first_name: 'A', last_name: 'Same' }),
    ];
    const mrrOf = () => null;
    expect(crmTableRows(rows, { ...DEFAULT_CRM_TABLE_FILTERS, sort: 'mrr' }, { today, mrrOf }).map((r) => r.id)).toEqual(['2', '1']);
    expect(crmTableRows(rows, DEFAULT_CRM_TABLE_FILTERS, { today, mrrOf }).map((r) => r.id)).toEqual(['2', '1']);
    expect(crmTableMrrTotal(rows, (r) => (r.id === '1' ? 50 : null))).toBe(50);
  });

  it('filters by status and by the Added window', () => {
    const rows = [contact('in', { status: 'hot', created_at: '2026-02-20T12:00:00Z' }), contact('old', { status: 'hot', created_at: '2025-01-01T12:00:00Z' })];
    expect(crmTableRows(rows, { sort: 'newest', status: 'hot', added: '30' }, { today, mrrOf: () => null }).map((r) => r.id)).toEqual(['in']);
    expect(crmTableRows(rows, { sort: 'newest', status: 'client', added: 'any' }, { today, mrrOf: () => null })).toEqual([]);
  });
});

describe('quote side effects', () => {
  const lead = { status: 'hot' };
  it('an accepted recurring quote makes a client, and the patch is the status alone', () => {
    expect(contactPatchForQuoteChange(lead, [{ state: 'accepted', cadence: 'annual' }])).toEqual({ status: 'client' });
  });
  it('accepted one-time work alone makes a one-time client', () => {
    expect(contactPatchForQuoteChange(lead, [{ state: 'accepted', cadence: 'one_time' }])).toEqual({ status: 'one_time' });
  });
  it('lost, cold and former clients are sticky', () => {
    for (const status of ['lost', 'cold', 'former_client']) {
      expect(contactPatchForQuoteChange({ status }, [{ state: 'accepted', cadence: 'monthly' }])).toBeNull();
    }
  });
  it('is null when nothing changes', () => {
    expect(contactPatchForQuoteChange({ status: 'one_time' }, [{ state: 'accepted', cadence: 'monthly' }])).toEqual({ status: 'client' });
    expect(contactPatchForQuoteChange({ status: 'client' }, [{ state: 'accepted', cadence: 'monthly' }])).toBeNull();
    expect(contactPatchForQuoteChange(lead, [{ state: 'proposed', cadence: 'monthly' }])).toBeNull();
  });
  it('a status change never carries client_since: the database stamps it from the stored value', () => {
    expect(statusChangePatch('client')).toEqual({ status: 'client' });
    expect(statusChangePatch('warm')).toEqual({ status: 'warm' });
  });
  it('only a well-formed amount parses; any typo is NaN and blank is null', () => {
    expect(parseCurrencyInput(' ')).toBeNull();
    // '.5' too: the shared rule (src/lib/money.ts) wants a digit before the point.
    for (const typo of ['abc', 'oops0', '0oops', '5x00', '1,25', '12,3456', '1.234', '1.2.3', '$', '-5', '--1', '1 000', '.5']) {
      expect(Number.isNaN(parseCurrencyInput(typo)), typo).toBe(true);
    }
    expect(parseCurrencyInput('$1,250.50')).toBe(1250.5);
    expect(parseCurrencyInput('1250')).toBe(1250);
    expect(parseCurrencyInput(' 0 ')).toBe(0);
    expect(parseCurrencyInput('$ 12,345,678.9')).toBe(12345678.9);
    expect(parseCurrencyInput('0.5')).toBe(0.5);
  });
});

describe('intake quotes', () => {
  const services = [
    { key: 'retainer', default_cadence: 'monthly' as const },
    { key: 'annual_plan', default_cadence: 'annual' as const },
  ];
  it('writes nothing for a blank or zero amount, and the state follows the status', () => {
    expect(intakeQuotes('c', 'new_lead', services, { retainer: '0', annual_plan: '' })).toEqual({ rows: [] });
    expect(intakeQuotes('c', 'hot', services, { retainer: '100' })).toEqual({
      rows: [{ contact_id: 'c', organization_id: null, service_type: 'retainer', state: 'proposed', cadence: 'monthly', amount: 100 }],
    });
    expect(intakeQuotes('c', 'one_time', services, { annual_plan: '300' })).toEqual({
      rows: [{ contact_id: 'c', organization_id: null, service_type: 'annual_plan', state: 'accepted', cadence: 'one_time', amount: 300 }],
    });
  });
  it('refuses an amount that is not a number', () => {
    expect(intakeQuotes('c', 'hot', services, { retainer: 'ten' })).toEqual({ error: expect.any(String) });
  });
});

describe('organizations', () => {
  it('lets every status reach active except by way of prospect, never back to prospect, and fails closed', () => {
    expect(allowedOrganizationStatusTargets('prospect')).toEqual(['prospect', 'active', 'closed']);
    expect(allowedOrganizationStatusTargets('active')).toEqual(['active', 'paused', 'closed']);
    expect(allowedOrganizationStatusTargets('paused')).toEqual(['paused', 'active', 'closed']);
    expect(allowedOrganizationStatusTargets('closed')).toEqual(['closed', 'active']);
    expect(allowedOrganizationStatusTargets('weird')).toEqual(['weird']);
    for (const s of ['active', 'paused', 'closed']) expect(allowedOrganizationStatusTargets(s)).not.toContain('prospect');
  });
  it('a name clash ignores case and spacing', () => {
    expect(findOrganizationNameClash([{ name: 'Acme  LLC' }], ' acme llc ')).toEqual({ name: 'Acme  LLC' });
    expect(findOrganizationNameClash([{ name: 'Acme LLC' }], 'Acme Inc')).toBeUndefined();
  });
});

describe('interaction helpers', () => {
  it('a key typed into a field or under an overlay is typing', () => {
    expect(isTypingContext({ tagName: 'input' }, false)).toBe(true);
    expect(isTypingContext({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'combobox' : null) }, false)).toBe(true);
    expect(isTypingContext({ tagName: 'DIV', isContentEditable: true }, false)).toBe(true);
    expect(isTypingContext({ tagName: 'DIV' }, true)).toBe(true);
    expect(isTypingContext({ tagName: 'BUTTON' }, false)).toBe(false);
  });
  it('a drop moves only onto another column', () => {
    const statusOf = (id: string) => (id === 'a' ? 'new_lead' : undefined);
    const columns = ['new_lead', 'hot'];
    expect(moveForDrop('a', 'hot', statusOf, columns)).toEqual({ contactId: 'a', status: 'hot' });
    expect(moveForDrop('a', 'new_lead', statusOf, columns)).toBeNull();
    expect(moveForDrop('a', null, statusOf, columns)).toBeNull();
    expect(moveForDrop('a', 'client', statusOf, columns)).toBeNull();
    expect(moveForDrop('zz', 'hot', statusOf, columns)).toBeNull();
  });
});

describe('activity labels', () => {
  it('cover exactly the actions the table allows', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/0002_contacts.sql'), 'utf8');
    const start = sql.indexOf('CREATE TABLE public.client_activity_log');
    const check = sql.slice(start, sql.indexOf(')),', start));
    const actions = [...check.slice(check.indexOf('action IN')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBe(19);
    expect(Object.keys(ACTIVITY_CATALOG).sort()).toEqual(actions.sort());
  });
  it('an unknown action renders under its key, and an object detail never prints as text', () => {
    expect(describeActivity('mystery', null).meta.label).toBe('mystery');
    expect(describeActivity('document_upload', { filename: { a: 1 } }).detail).toBe('');
    expect(describeActivity('document_upload', { filename: 'scan.pdf' }).detail).toBe('scan.pdf');
  });
});

describe('the CSV export', () => {
  it('neutralises a formula in a lead-supplied name, and hides money on a terminal status', () => {
    const rows = contactCsvRows(
      [
        contact('a', { full_name: '=HYPERLINK("http://x")', status: 'client', contact_services: [quote({ state: 'accepted', amount: '100' })] }),
        contact('b', { status: 'lost', contact_services: [quote({ state: 'accepted', amount: '100' })] }),
      ],
      { businessOf: () => '', statusLabel: (s) => s },
    );
    const parsed = parseCsv(toCsv(rows));
    expect(parsed[0]).toEqual(['Name', 'Email', 'Phone', 'Business', 'Status', 'MRR', 'ARR']);
    expect(parsed[1][0]).toBe(`'=HYPERLINK("http://x")`);
    expect(parsed[1].slice(5)).toEqual(['100', '1200']);
    expect(parsed[2].slice(5)).toEqual(['', '']);
  });
});

it('the status keys offered never include a system status', () => {
  expect(SELECTABLE_STATUSES).not.toContain('esign_signer');
});

describe('tabs', () => {
  it('run Pipeline, Tiers, Table, each naming a real list (Clients and All are the panel switch)', () => {
    expect(CRM_TABS.map((t) => t.key)).toEqual(['pipeline', 'tiers', 'table']);
    const lists = new Set<string>(CRM_LISTS.map((l) => l.key));
    for (const t of CRM_TABS) expect(lists.has(t.list), t.key).toBe(true);
  });

  it('Tiers lists the active clients and draws the tier rows; Table draws the table', () => {
    expect(CRM_TABS.find((t) => t.key === 'tiers')).toMatchObject({ list: 'active', pane: 'tiers' });
    expect(CRM_TABS.find((t) => t.key === 'table')).toMatchObject({ list: 'all', pane: 'table' });
  });

  it('an explicit ?tab= wins, then the remembered tab, then Pipeline; anything else is refused', () => {
    expect(resolveCrmTab('tiers', 'table')).toBe('tiers');
    expect(resolveCrmTab(null, 'table')).toBe('table');
    expect(resolveCrmTab('nonsense', 'tiers')).toBe('tiers');
    expect(resolveCrmTab(null, null)).toBe('pipeline');
    expect(resolveCrmTab(null, 3)).toBe('pipeline');
    // The old list tabs, linked or remembered, are not tabs any more.
    expect(resolveCrmTab('clients', null)).toBe('pipeline');
    expect(resolveCrmTab(null, 'all')).toBe('pipeline');
    expect(isCrmTabKey('leads')).toBe(false);
  });
});

describe('the merged Clients list', () => {
  const rows = [
    contact('1', { status: 'client', first_name: 'Al', last_name: 'Young' }),
    contact('2', { status: 'one_time', first_name: 'Jo', last_name: 'Adams' }),
    contact('3', { status: 'client', first_name: 'Kim', last_name: 'Brown' }),
    contact('4', { status: 'one_time', first_name: 'Abe', last_name: 'Brown' }),
    contact('5', { status: 'new_lead', first_name: 'Lee', last_name: 'Zed' }),
  ];

  it('folds one-time clients into one list, A-Z by last name then first', () => {
    const merged = mergeClientSections(bucketBySection(rows));
    const clients = merged.find((s) => s.status === 'client')!;
    expect(clients.rows.map((r) => r.id)).toEqual(['2', '4', '3', '1']);
    expect(clients.collapsible).toBe(false);
    expect(merged.some((s) => s.status === 'one_time')).toBe(false);
  });

  it('leaves every other section alone', () => {
    const merged = mergeClientSections(bucketBySection(rows));
    expect(merged.find((s) => s.status === 'new_lead')!.rows.map((r) => r.id)).toEqual(['5']);
    expect(merged).toHaveLength(CRM_SECTIONS.length - 1);
  });
});
