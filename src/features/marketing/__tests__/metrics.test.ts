import { describe, expect, it } from 'vitest';
import { aggregateUpsells, type UpsellForRollup } from '@/lib/revenue';
import {
  aggregateRevenue,
  leadMonth,
  leadsAndWonByMonth,
  leadsBySource,
  marketingSeries,
  monthlyMarketing,
  needsFixing,
  serviceRevenueRows,
  sourceValue,
  sparkBarHeight,
  sumServiceRows,
  totalMarketing,
  wonCohortFees,
  type MarketingContact,
  type MarketingQuote,
} from '../lib/metrics';
import { monthLabel, monthsEnding, monthsNewestFirst } from '../lib/months';

// Fixture service types are the ones 0002 seeds: retainer (monthly), annual_plan (annual),
// project and consultation (one-time).
const svc = (service_type: string, state: string, cadence: string, amount: number | string | null): MarketingQuote => ({
  service_type,
  state,
  cadence,
  amount,
});

let seq = 0;
const make = (o: Partial<MarketingContact> = {}): MarketingContact => ({
  id: o.id ?? `c-${++seq}`,
  // Mid-month instants, so the local month is the same in every zone a test runs in.
  created_at: '2026-01-15T12:00:00Z',
  submitted_at: null,
  status: 'client',
  source: 'referral',
  client_since: null,
  contact_services: [],
  ...o,
});

describe('aggregateRevenue', () => {
  it('is all zeroes for an empty list', () => {
    expect(aggregateRevenue([])).toEqual({
      totalMRR: 0, totalARR: 0, pipelineARR: 0, proposedMRR: 0, oneTimeRevenue: 0, recurringClientsCount: 0,
    });
  });

  it('counts MRR and ARR on active clients only, and annual quotes into ARR once', () => {
    const t = aggregateRevenue([
      make({ contact_services: [svc('retainer', 'accepted', 'monthly', 500), svc('annual_plan', 'accepted', 'annual', 1200)] }),
      make({ status: 'former_client', contact_services: [svc('retainer', 'accepted', 'monthly', 999)] }),
      make({ status: 'new_lead', contact_services: [svc('retainer', 'accepted', 'monthly', 999)] }),
    ]);
    expect(t.totalMRR).toBe(500);
    expect(t.totalARR).toBe(500 * 12 + 1200);
    expect(t.recurringClientsCount).toBe(1);
  });

  it('a client with only one-time work is not a recurring client', () => {
    const t = aggregateRevenue([make({ contact_services: [svc('project', 'accepted', 'one_time', 300)] })]);
    expect(t.recurringClientsCount).toBe(0);
    expect(t.oneTimeRevenue).toBe(300);
    expect(t.totalARR).toBe(0);
  });

  it('reads numeric strings as PostgREST returns them', () => {
    const t = aggregateRevenue([make({ contact_services: [svc('retainer', 'accepted', 'monthly', '250.50')] })]);
    expect(t.totalMRR).toBe(250.5);
    expect(t.totalARR).toBe(3006);
  });

  it('counts proposed pipeline on active-pipeline contacts only; cold, lost and signer-only are out', () => {
    const t = aggregateRevenue([
      make({ status: 'hot', contact_services: [svc('retainer', 'proposed', 'monthly', 100)] }),
      make({ status: 'cold', contact_services: [svc('retainer', 'proposed', 'monthly', 999)] }),
      make({ status: 'lost', contact_services: [svc('retainer', 'proposed', 'monthly', 999)] }),
      make({ status: 'esign_signer', contact_services: [svc('annual_plan', 'proposed', 'annual', 999)] }),
    ]);
    expect(t.proposedMRR).toBe(100);
    expect(t.pipelineARR).toBe(1200);
  });
});

describe('serviceRevenueRows (the Revenue table)', () => {
  const ORDER = ['retainer', 'annual_plan', 'project', 'consultation', 'other'];
  const byService = (rows: ReturnType<typeof serviceRevenueRows>, s: string) => rows.find((r) => r.service === s);

  it('returns no rows for an empty list', () => {
    expect(serviceRevenueRows([], ORDER)).toEqual([]);
  });

  it('follows the service_types order, with a service off the list appended, never dropped', () => {
    const c = make({
      contact_services: [
        svc('other', 'accepted', 'annual', 100),
        svc('zzz_retired', 'accepted', 'annual', 50),
        svc('retainer', 'accepted', 'monthly', 500),
        svc('project', 'accepted', 'one_time', 400),
      ],
    });
    expect(serviceRevenueRows([c], ORDER).map((r) => r.service)).toEqual(['retainer', 'project', 'other', 'zzz_retired']);
  });

  it('counts a contact once per service even with quotes on several businesses', () => {
    const c = make({ contact_services: [svc('retainer', 'accepted', 'monthly', 300), svc('retainer', 'accepted', 'monthly', 200)] });
    expect(byService(serviceRevenueRows([c], ORDER), 'retainer')).toMatchObject({ clients: 1, mrr: 500, arr: 6000 });
  });

  it('one-time cadence lands in oneTime, never MRR or ARR', () => {
    const c = make({ contact_services: [svc('project', 'accepted', 'one_time', 425)] });
    expect(byService(serviceRevenueRows([c], ORDER), 'project')).toMatchObject({ oneTime: 425, arr: 0, mrr: 0, clients: 0 });
  });

  it('a one_time contact reroutes every accepted quote to oneTime', () => {
    const c = make({ status: 'one_time', contact_services: [svc('retainer', 'accepted', 'monthly', 100), svc('annual_plan', 'accepted', 'annual', 1000)] });
    const rows = serviceRevenueRows([c], ORDER);
    expect(byService(rows, 'retainer')).toMatchObject({ oneTime: 100, mrr: 0, arr: 0 });
    expect(byService(rows, 'annual_plan')).toMatchObject({ oneTime: 1000, arr: 0 });
  });

  it('proposed one-time is cadence-driven and stays out of proposed ARR', () => {
    const c = make({ status: 'new_lead', contact_services: [svc('project', 'proposed', 'one_time', 2000), svc('retainer', 'proposed', 'monthly', 500)] });
    const rows = serviceRevenueRows([c], ORDER);
    expect(byService(rows, 'project')).toMatchObject({ proposedOneTime: 2000, proposedARR: 0, proposedMRR: 0 });
    expect(byService(rows, 'retainer')).toMatchObject({ proposedMRR: 500, proposedARR: 6000, proposedOneTime: 0 });
  });

  it('leaves lost, cold, former and signer-only contacts out of the proposed columns', () => {
    const out = ['lost', 'cold', 'former_client', 'esign_signer'].map((status) =>
      make({ status, contact_services: [svc('retainer', 'proposed', 'monthly', 999)] }),
    );
    for (const r of serviceRevenueRows(out, ORDER)) expect(r.proposedMRR + r.proposedARR + r.proposedOneTime).toBe(0);
  });

  // THE contract: the table's footer must equal the scalars the rest of the page reports.
  it('rows sum to aggregateRevenue on a mixed book', () => {
    const contacts = [
      make({
        contact_services: [
          svc('retainer', 'accepted', 'monthly', 500),
          svc('annual_plan', 'accepted', 'annual', 1625),
          svc('project', 'accepted', 'one_time', 425),
        ],
      }),
      make({ contact_services: [svc('retainer', 'accepted', 'monthly', '1000.00')] }),
      make({ status: 'one_time', contact_services: [svc('annual_plan', 'accepted', 'annual', 900)] }),
      make({
        status: 'warm',
        contact_services: [
          svc('retainer', 'proposed', 'monthly', 900),
          svc('annual_plan', 'proposed', 'annual', 3000),
          svc('consultation', 'proposed', 'one_time', 750),
        ],
      }),
      make({ status: 'lost', contact_services: [svc('retainer', 'proposed', 'monthly', 5000)] }),
    ];
    const rows = serviceRevenueRows(contacts, ORDER);
    const agg = aggregateRevenue(contacts);
    const sum = sumServiceRows(rows);
    expect(sum.mrr).toBe(agg.totalMRR);
    expect(sum.arr).toBe(agg.totalARR);
    expect(sum.oneTime).toBe(agg.oneTimeRevenue);
    expect(sum.proposedMRR).toBe(agg.proposedMRR);
    expect(sum.proposedARR).toBe(agg.pipelineARR);
    expect(agg.oneTimeRevenue).toBe(425 + 900);
  });
});

describe('upsells in the rollup', () => {
  it('counts open and pitched upsells on live contacts only; won and passed never', () => {
    const live = make({ id: 'live', status: 'hot' });
    const lost = make({ id: 'gone', status: 'lost' });
    const byId = new Map([live, lost].map((c) => [c.id, c]));
    const rows: UpsellForRollup[] = [
      { status: 'open', cadence: 'monthly', est_amount: 175, contact_id: 'live' },
      { status: 'won', cadence: 'monthly', est_amount: 999, contact_id: 'live' },
      { status: 'passed', cadence: 'annual', est_amount: 999, contact_id: 'live' },
      { status: 'pitched', cadence: 'monthly', est_amount: 999, contact_id: 'gone' },
    ];
    expect(aggregateUpsells(rows, byId)).toEqual({ proposedMRR: 175, proposedARR: 2100, proposedAnnual: 0, proposedOneTime: 0 });
  });
});

describe('leadMonth', () => {
  it('reads submitted_at first, then created_at', () => {
    expect(leadMonth({ submitted_at: '2026-02-14T12:00:00Z', created_at: '2026-05-14T12:00:00Z' })).toBe('2026-02');
    expect(leadMonth({ submitted_at: null, created_at: '2026-05-14T12:00:00Z' })).toBe('2026-05');
  });

  it('takes the month of the LOCAL calendar day, not of the UTC string', () => {
    // Midnight local time on the 1st is still the 31st in UTC east of Greenwich, and the
    // last evening of a month is already the 1st in UTC west of it. Built from local parts
    // so the assertion holds in every zone.
    const firstOfMarch = new Date(2026, 2, 1, 0, 30).toISOString();
    const lastEveningOfMarch = new Date(2026, 2, 31, 23, 30).toISOString();
    expect(leadMonth({ submitted_at: firstOfMarch, created_at: firstOfMarch })).toBe('2026-03');
    expect(leadMonth({ submitted_at: lastEveningOfMarch, created_at: lastEveningOfMarch })).toBe('2026-03');
  });
});

describe('leadsAndWonByMonth (the one definition)', () => {
  it('counts a lead by arrival and a win by client_since, client or one-time', () => {
    const { leadsByMonth, wonByMonth } = leadsAndWonByMonth([
      make({ client_since: '2026-05-02', submitted_at: '2026-04-15T12:00:00Z' }),
      make({ status: 'one_time', client_since: '2026-05-20', submitted_at: '2026-05-15T12:00:00Z' }),
    ]);
    expect(wonByMonth.get('2026-05')).toBe(2);
    expect(leadsByMonth.get('2026-04')).toBe(1);
    expect(leadsByMonth.get('2026-05')).toBe(1);
  });

  it('a client later marked former client still counts in the month they were won', () => {
    const { wonByMonth } = leadsAndWonByMonth([make({ status: 'former_client', client_since: '2026-03-05' })]);
    expect(wonByMonth.get('2026-03')).toBe(1);
  });

  it('does not count a lost contact carrying a stale client_since, or a client with none', () => {
    const { wonByMonth } = leadsAndWonByMonth([make({ status: 'lost', client_since: '2026-05-02' }), make({ client_since: null })]);
    expect(wonByMonth.size).toBe(0);
  });
});

describe('monthlyMarketing / totalMarketing', () => {
  const goals = [
    { month: '2026-08', ad_spend: '100.00', new_leads_target: 10, closed_clients_target: 4 },
    { month: '2026-07', ad_spend: 200, new_leads_target: 5, closed_clients_target: 2 },
  ];

  it('one row per month, newest first, each with its own targets and null where no goal row exists', () => {
    const rows = monthlyMarketing([], goals, '2026-06', '2026-08');
    expect(rows.map((r) => r.month)).toEqual(['2026-08', '2026-07', '2026-06']);
    expect(rows[0]).toMatchObject({ newLeadsTarget: 10, adSpend: 100, monthLabel: 'Aug 2026' });
    expect(rows[1].closedClientsTarget).toBe(2);
    expect(rows[2].newLeadsTarget).toBeNull();
    expect(rows[2].closedClientsTarget).toBeNull();
  });

  it('cost per lead, per client and conversion from the month counts', () => {
    const contacts = [
      make({ submitted_at: '2026-08-10T12:00:00Z', client_since: '2026-08-20' }),
      make({ status: 'new_lead', submitted_at: '2026-08-11T12:00:00Z' }),
      make({ status: 'new_lead', submitted_at: '2026-08-12T12:00:00Z' }),
      make({ status: 'new_lead', submitted_at: '2026-08-13T12:00:00Z' }),
    ];
    const [aug] = monthlyMarketing(contacts, goals, '2026-08', '2026-08');
    expect(aug).toMatchObject({ leads: 4, closed: 1, cpl: 25, cac: 100, convPct: 25 });
  });

  it('sums only the months that carry a target', () => {
    const totals = totalMarketing(monthlyMarketing([], goals, '2026-06', '2026-08'));
    expect(totals).toMatchObject({ leadsTarget: 15, closedTarget: 6, adSpend: 300 });
  });

  it('returns null totals when no month in the range has a target', () => {
    const totals = totalMarketing(monthlyMarketing([], [], '2026-06', '2026-08'));
    expect(totals.leadsTarget).toBeNull();
    expect(totals.closedTarget).toBeNull();
    expect(totals.leads).toBe(0);
  });

  it('a spend-only month (NULL targets) adds no target', () => {
    const rows = monthlyMarketing([], [{ month: '2026-08', ad_spend: 50, new_leads_target: null, closed_clients_target: null }], '2026-08', '2026-08');
    expect(totalMarketing(rows).leadsTarget).toBeNull();
  });

  it('distinguishes a target of 0 from no target at all', () => {
    const rows = monthlyMarketing([], [{ month: '2026-08', ad_spend: 0, new_leads_target: 0, closed_clients_target: 0 }], '2026-08', '2026-08');
    expect(rows[0].newLeadsTarget).toBe(0);
    expect(totalMarketing(rows).leadsTarget).toBe(0);
  });

  // The picker refuses a range past MAX_RANGE_MONTHS; this never trims one, so the table,
  // the fees and the goal builder's pace always cover the same months.
  it('draws every month of the range, never trimming the earliest', () => {
    const rows = monthlyMarketing([], [], '2000-01', '2026-08');
    expect(rows).toHaveLength(26 * 12 + 8);
    expect(rows[rows.length - 1].month).toBe('2000-01');
  });
});

describe('wonCohortFees (the goal builder input)', () => {
  const won = (o: Partial<MarketingContact>) => make({ client_since: '2026-05-10', ...o });

  it('values a client at CONTACT grain, not per quote', () => {
    const f = wonCohortFees([won({ contact_services: [svc('retainer', 'accepted', 'monthly', 300), svc('retainer', 'accepted', 'monthly', 200)] })], '2026-01', '2026-12');
    expect(f.recurringWins).toBe(1);
    expect(f.avgRecurringARR).toBe(6000);
  });

  it('annualizes monthly and passes annual through', () => {
    const f = wonCohortFees(
      [won({ contact_services: [svc('retainer', 'accepted', 'monthly', 500)] }), won({ contact_services: [svc('annual_plan', 'accepted', 'annual', 6000)] })],
      '2026-01',
      '2026-12',
    );
    expect(f).toMatchObject({ avgRecurringARR: 6000, recurringWins: 2 });
  });

  it('reports a won client with no accepted quote instead of averaging it in as zero', () => {
    const f = wonCohortFees(
      [
        won({ contact_services: [svc('retainer', 'accepted', 'monthly', 500)] }),
        won({ contact_services: [] }),
        won({ contact_services: [svc('retainer', 'proposed', 'monthly', 900)] }),
      ],
      '2026-01',
      '2026-12',
    );
    expect(f).toMatchObject({ wins: 3, withFees: 1, withoutFees: 2, avgRecurringARR: 6000 });
  });

  it('measures recurring and one-time separately, so a client can be in both', () => {
    const f = wonCohortFees([won({ contact_services: [svc('retainer', 'accepted', 'monthly', 400), svc('project', 'accepted', 'one_time', 900)] })], '2026-01', '2026-12');
    expect(f).toMatchObject({ wins: 1, recurringWins: 1, oneTimeWins: 1, avgRecurringARR: 4800, avgOneTime: 900 });
  });

  it('reroutes a one_time client’s monthly quote to one-time, not recurring', () => {
    const f = wonCohortFees([won({ status: 'one_time', contact_services: [svc('retainer', 'accepted', 'monthly', 500)] })], '2026-01', '2026-12');
    expect(f).toMatchObject({ recurringWins: 0, oneTimeWins: 1, avgOneTime: 500 });
  });

  it('honours the window, and leaves out contacts that never became clients', () => {
    const f = wonCohortFees(
      [
        won({ contact_services: [svc('retainer', 'accepted', 'monthly', 100)] }),
        make({ client_since: '2025-02-01', contact_services: [svc('retainer', 'accepted', 'monthly', 999)] }),
        make({ status: 'active_lead', client_since: null, contact_services: [svc('retainer', 'accepted', 'monthly', 999)] }),
      ],
      '2026-01',
      '2026-12',
    );
    expect(f).toMatchObject({ wins: 1, avgRecurringARR: 1200 });
  });

  it('returns zeroes rather than NaN when the window holds no wins', () => {
    expect(wonCohortFees([], '2026-01', '2026-12')).toEqual({
      wins: 0, withFees: 0, withoutFees: 0, recurringWins: 0, oneTimeWins: 0, avgRecurringARR: 0, avgOneTime: 0,
    });
  });
});

describe('sourceValue (what a source was worth, in dollars)', () => {
  const won = (source: string, rows: MarketingQuote[], o: Partial<MarketingContact> = {}) =>
    make({ source, submitted_at: '2026-02-15T12:00:00Z', client_since: '2026-05-01', contact_services: rows, ...o });

  it('annualizes a monthly fee and keeps one-time money out of ARR', () => {
    const [r] = sourceValue([won('referral', [svc('retainer', 'accepted', 'monthly', 500), svc('project', 'accepted', 'one_time', 400)])], '2026-01', '2026-12');
    expect(r).toMatchObject({ recurringARR: 6000, oneTime: 400, valuePerLead: 6400 });
  });

  it('counts an annual fee at face value, not twelve times over', () => {
    expect(sourceValue([won('website', [svc('annual_plan', 'accepted', 'annual', 2400)])], '2026-01', '2026-12')[0].recurringARR).toBe(2400);
  });

  it('reroutes a one_time contact’s monthly quote to one-time', () => {
    const [r] = sourceValue([won('referral', [svc('retainer', 'accepted', 'monthly', 500)], { status: 'one_time' })], '2026-01', '2026-12');
    expect(r).toMatchObject({ recurringARR: 0, oneTime: 500 });
  });

  it('ignores a proposed quote: a source is credited with money that was accepted', () => {
    const [r] = sourceValue([won('website', [svc('retainer', 'proposed', 'monthly', 900)])], '2026-01', '2026-12');
    expect(r).toMatchObject({ wins: 1, recurringARR: 0 });
  });

  it('keeps a source that sent leads and won nothing', () => {
    const out = sourceValue(
      [make({ source: 'advertising', status: 'new_lead', submitted_at: '2026-03-15T12:00:00Z' }), won('referral', [svc('retainer', 'accepted', 'monthly', 100)])],
      '2026-01',
      '2026-12',
    );
    expect(out.find((r) => r.source === 'advertising')).toEqual({ source: 'advertising', leads: 1, wins: 0, recurringARR: 0, oneTime: 0, valuePerLead: 0 });
  });

  it('ranks by total dollars, so a small high-value source beats a big cheap one', () => {
    const out = sourceValue(
      [
        won('referral', [svc('retainer', 'accepted', 'monthly', 1000)]),
        won('search', [svc('retainer', 'accepted', 'monthly', 100)]),
        won('search', [svc('retainer', 'accepted', 'monthly', 100)]),
        make({ source: 'search', status: 'new_lead', submitted_at: '2026-02-15T12:00:00Z' }),
      ],
      '2026-01',
      '2026-12',
    );
    expect(out.map((r) => r.source)).toEqual(['referral', 'search']);
    expect(out[0].valuePerLead).toBe(12000);
    expect(out[1].valuePerLead).toBe(800);
  });

  it('leaves out a lead who arrived before the range even though they won inside it', () => {
    expect(sourceValue([won('referral', [svc('retainer', 'accepted', 'monthly', 500)], { submitted_at: '2025-11-15T12:00:00Z' })], '2026-01', '2026-12')).toEqual([]);
  });

  it('a former client still counts as a win for the source that sent them', () => {
    const [r] = sourceValue([won('referral', [svc('retainer', 'accepted', 'monthly', 100)], { status: 'former_client' })], '2026-01', '2026-12');
    expect(r.wins).toBe(1);
  });

  it('the lead chart counts the same cohort, every source it found', () => {
    const contacts = [
      make({ source: 'esign', status: 'esign_signer', submitted_at: '2026-02-15T12:00:00Z' }),
      make({ source: 'referral', submitted_at: '2026-02-15T12:00:00Z' }),
      make({ source: 'referral', submitted_at: '2026-03-15T12:00:00Z' }),
    ];
    expect(leadsBySource(contacts, '2026-01', '2026-12')).toEqual([
      { source: 'referral', leads: 2 },
      { source: 'esign', leads: 1 },
    ]);
    const tableLeads = sourceValue(contacts, '2026-01', '2026-12').reduce((s, r) => s + r.leads, 0);
    expect(tableLeads).toBe(3);
  });
});

describe('needsFixing', () => {
  const contacts = [
    make({ id: 'priced', client_since: '2026-01-15', contact_services: [svc('retainer', 'accepted', 'monthly', 500)] }),
    make({ id: 'zero', client_since: '2026-01-15', contact_services: [svc('annual_plan', 'accepted', 'annual', 0)] }),
    make({ id: 'proposed', client_since: '2026-01-15', contact_services: [svc('retainer', 'proposed', 'monthly', 400)] }),
    make({ id: 'once', status: 'one_time', client_since: null, contact_services: [svc('project', 'accepted', 'one_time', 750)] }),
    make({ id: 'lead', status: 'new_lead', contact_services: [] }),
    make({ id: 'left', status: 'former_client', client_since: null, contact_services: [] }),
  ];
  const f = needsFixing(contacts);

  it('lists customers with no accepted price above zero, and only customers', () => {
    expect(f.noPrice.map((c) => c.id).sort()).toEqual(['proposed', 'zero']);
  });

  it('lists customers with no client-since date, and only customers', () => {
    expect(f.noSince.map((c) => c.id)).toEqual(['once']);
  });

  it('totals quoted MRR on active clients', () => {
    expect(f.quotedMRR).toBe(500);
  });
});

describe('the Overview chart', () => {
  it('monthsEnding runs oldest first across a year boundary', () => {
    expect(monthsEnding('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('monthsNewestFirst and monthLabel', () => {
    expect(monthsNewestFirst('2025-11', '2026-01', 240)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(monthLabel('2026-01')).toBe('Jan 2026');
  });

  it('counts leads by arrival and wins by client-since, a former client included', () => {
    const s = marketingSeries(
      [
        make({ submitted_at: '2026-02-10T12:00:00Z', client_since: '2026-03-05' }),
        make({ status: 'new_lead', submitted_at: '2026-02-20T12:00:00Z' }),
        make({ status: 'former_client', submitted_at: '2026-01-10T12:00:00Z', client_since: '2026-03-07' }),
      ],
      ['2026-01', '2026-02', '2026-03'],
    );
    expect(s.map((p) => p.leads)).toEqual([1, 2, 0]);
    expect(s.map((p) => p.won)).toEqual([0, 0, 2]);
  });

  it('sparkBarHeight: no bar for no data, a hairline for zero, a floor for small values', () => {
    expect(sparkBarHeight(null, 100)).toBeNull();
    expect(sparkBarHeight(0, 100)).toBe(0);
    expect(sparkBarHeight(1, 100)).toBe(8);
    expect(sparkBarHeight(50, 100)).toBe(50);
    expect(sparkBarHeight(0, 0)).toBe(0);
  });
});
