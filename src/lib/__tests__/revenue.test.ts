// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  aggregateUpsells,
  computeContactRevenue,
  contactProposedTotals,
  num,
  oneTimeAmountFor,
  upsellProposedTotals,
  type ContactForRevenue,
  type QuoteForRevenue,
  type UpsellForRollup,
} from '@/lib/revenue';

// A quote row as contact_services(*) returns it; the service key never changes the math.
const svc = (
  service_type: string,
  state: string,
  cadence: string,
  amount: number | string | null,
  organization_id: string | null = null,
): QuoteForRevenue & { service_type: string; organization_id: string | null } => ({
  service_type,
  state,
  cadence,
  amount,
  organization_id,
});

const contact = (overrides: Partial<ContactForRevenue> = {}): ContactForRevenue => ({
  status: 'client',
  contact_services: [],
  ...overrides,
});

const ZERO = { mrr: 0, arr: 0, proposedAnnualized: 0, proposedMRR: 0, oneTimeTotal: 0 };

describe('num', () => {
  it('reads numbers and numeric strings; null, empty and junk are 0', () => {
    expect(num(12.5)).toBe(12.5);
    expect(num('500.00')).toBe(500);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('')).toBe(0);
    expect(num('abc')).toBe(0);
  });
});

describe('computeContactRevenue', () => {
  it('counts accepted monthly quotes as MRR and annualizes them into ARR', () => {
    const r = computeContactRevenue(contact({ contact_services: [svc('retainer', 'accepted', 'monthly', 500)] }));
    expect(r.mrr).toBe(500);
    expect(r.arr).toBe(6000);
    expect(r.oneTimeTotal).toBe(0);
  });

  it('sums quotes across the person and every business', () => {
    const r = computeContactRevenue(
      contact({
        contact_services: [
          svc('retainer', 'accepted', 'monthly', 1000),
          svc('retainer', 'accepted', 'monthly', 300, 'org-1'),
          svc('other', 'accepted', 'monthly', 200, 'org-2'),
        ],
      }),
    );
    expect(r.mrr).toBe(1500);
    expect(r.arr).toBe(18000);
  });

  it('adds every accepted annual quote to ARR once', () => {
    const r = computeContactRevenue(
      contact({
        contact_services: [
          svc('retainer', 'accepted', 'monthly', 500),
          svc('annual_plan', 'accepted', 'annual', 1625),
          svc('annual_plan', 'accepted', 'annual', 425, 'org-1'),
          svc('other', 'accepted', 'annual', 300),
        ],
      }),
    );
    expect(r.mrr).toBe(500);
    expect(r.arr).toBe(6000 + 1625 + 425 + 300);
  });

  it('an accepted annual quote alone is ARR, not MRR', () => {
    const r = computeContactRevenue(contact({ contact_services: [svc('annual_plan', 'accepted', 'annual', 1500)] }));
    expect(r.mrr).toBe(0);
    expect(r.arr).toBe(1500);
  });

  it('routes proposed quotes to the proposed figures, not to MRR or ARR', () => {
    const r = computeContactRevenue(
      contact({
        status: 'new_lead',
        contact_services: [svc('retainer', 'proposed', 'monthly', 400), svc('annual_plan', 'proposed', 'annual', 425)],
      }),
    );
    expect(r.mrr).toBe(0);
    expect(r.arr).toBe(0);
    expect(r.proposedMRR).toBe(400);
    expect(r.proposedAnnualized).toBe(400 * 12 + 425);
  });

  it('a proposed one-time quote does not annualize into the proposed figures', () => {
    const r = computeContactRevenue(
      contact({
        status: 'new_lead',
        contact_services: [
          svc('retainer', 'proposed', 'monthly', 500),
          svc('annual_plan', 'proposed', 'annual', 1200),
          svc('project', 'proposed', 'one_time', 9000),
        ],
      }),
    );
    expect(r.proposedMRR).toBe(500);
    expect(r.proposedAnnualized).toBe(7200);
  });

  it('proposedMRR is 0 once the quote is accepted', () => {
    const r = computeContactRevenue(contact({ contact_services: [svc('retainer', 'accepted', 'monthly', 300)] }));
    expect(r.proposedMRR).toBe(0);
  });

  it('a contact with no quotes, or no embedded array, counts toward nothing', () => {
    expect(computeContactRevenue(contact())).toEqual(ZERO);
    expect(computeContactRevenue(contact({ contact_services: undefined }))).toEqual(ZERO);
    expect(computeContactRevenue(contact({ contact_services: null }))).toEqual(ZERO);
  });

  it('counts accepted one-time quotes in the one-time total only', () => {
    const r = computeContactRevenue(
      contact({
        status: 'new_lead',
        contact_services: [svc('project', 'accepted', 'one_time', 425), svc('consultation', 'accepted', 'one_time', 1000)],
      }),
    );
    expect(r.oneTimeTotal).toBe(1425);
    expect(r.mrr).toBe(0);
    expect(r.arr).toBe(0);
    expect(r.proposedAnnualized).toBe(0);
  });

  it('on a one_time contact, every accepted quote is one-time revenue, not ARR', () => {
    const r = computeContactRevenue(
      contact({
        status: 'one_time',
        contact_services: [
          svc('annual_plan', 'accepted', 'annual', 425),
          svc('other', 'accepted', 'annual', 300),
          svc('retainer', 'accepted', 'monthly', 100),
        ],
      }),
    );
    expect(r.oneTimeTotal).toBe(825);
    expect(r.mrr).toBe(0);
    expect(r.arr).toBe(0);
  });

  it('still counts proposed pipeline on a one_time contact', () => {
    const r = computeContactRevenue(
      contact({
        status: 'one_time',
        contact_services: [svc('project', 'accepted', 'one_time', 425), svc('retainer', 'proposed', 'monthly', 400)],
      }),
    );
    expect(r.oneTimeTotal).toBe(425);
    expect(r.proposedAnnualized).toBe(4800);
  });

  it('reads numeric strings as PostgREST returns them', () => {
    const r = computeContactRevenue(
      contact({ contact_services: [svc('retainer', 'accepted', 'monthly', '500.00'), svc('project', 'accepted', 'one_time', '425.00')] }),
    );
    expect(r.mrr).toBe(500);
    expect(r.arr).toBe(6000);
    expect(r.oneTimeTotal).toBe(425);
  });
});

describe('oneTimeAmountFor', () => {
  it('counts accepted one-time cadence', () => {
    expect(oneTimeAmountFor(contact({ contact_services: [svc('project', 'accepted', 'one_time', 425)] }))).toBe(425);
  });

  it('on a one_time contact, counts every accepted quote whatever its cadence', () => {
    const c = contact({
      status: 'one_time',
      contact_services: [svc('retainer', 'accepted', 'monthly', 100), svc('annual_plan', 'accepted', 'annual', 1000)],
    });
    expect(oneTimeAmountFor(c)).toBe(1100);
  });

  it('counts a one-time quote on a one_time contact once, not twice', () => {
    expect(oneTimeAmountFor(contact({ status: 'one_time', contact_services: [svc('project', 'accepted', 'one_time', 425)] }))).toBe(425);
  });

  it('ignores proposed quotes', () => {
    expect(oneTimeAmountFor(contact({ status: 'one_time', contact_services: [svc('project', 'proposed', 'one_time', 425)] }))).toBe(0);
  });
});

describe('upsellProposedTotals', () => {
  const u = (o: Partial<UpsellForRollup>): UpsellForRollup => ({ status: 'open', cadence: 'monthly', est_amount: 0, ...o });

  it('a monthly upsell is proposed MRR and x12 into proposed ARR', () => {
    expect(upsellProposedTotals([u({ cadence: 'monthly', est_amount: 175 })])).toEqual({
      proposedMRR: 175,
      proposedARR: 2100,
      proposedAnnual: 0,
      proposedOneTime: 0,
    });
  });

  it('an annual upsell is proposed ARR once, with no MRR', () => {
    expect(upsellProposedTotals([u({ status: 'pitched', cadence: 'annual', est_amount: 1500 })])).toEqual({
      proposedMRR: 0,
      proposedARR: 1500,
      proposedAnnual: 1500,
      proposedOneTime: 0,
    });
  });

  it('a one-time upsell never reaches ARR', () => {
    expect(upsellProposedTotals([u({ cadence: 'one_time', est_amount: 2000 })])).toEqual({
      proposedMRR: 0,
      proposedARR: 0,
      proposedAnnual: 0,
      proposedOneTime: 2000,
    });
  });

  it('won and passed upsells count for nothing (a won one is already a quote)', () => {
    const rows = [u({ status: 'won', cadence: 'monthly', est_amount: 500 }), u({ status: 'passed', cadence: 'annual', est_amount: 500 })];
    expect(upsellProposedTotals(rows)).toEqual({ proposedMRR: 0, proposedARR: 0, proposedAnnual: 0, proposedOneTime: 0 });
  });

  it('reads numeric strings', () => {
    expect(upsellProposedTotals([u({ est_amount: '175.00' })]).proposedMRR).toBe(175);
  });

  it('two monthly upsells and no annual one leave proposedAnnual at exactly 0', () => {
    expect(upsellProposedTotals([u({ est_amount: 0.1 }), u({ est_amount: 0.2 })]).proposedAnnual).toBe(0);
  });
});

describe('contactProposedTotals', () => {
  it("adds the open upsells to the contact's own proposed quotes", () => {
    const revenue = computeContactRevenue(
      contact({
        status: 'hot',
        contact_services: [svc('retainer', 'proposed', 'monthly', 300), svc('annual_plan', 'proposed', 'annual', 1000)],
      }),
    );
    const upsells: UpsellForRollup[] = [
      { status: 'open', cadence: 'monthly', est_amount: 175 },
      { status: 'won', cadence: 'monthly', est_amount: 999 },
      { status: 'pitched', cadence: 'annual', est_amount: 500 },
    ];
    expect(contactProposedTotals(revenue, upsells)).toEqual({
      proposedMRR: 300 + 175,
      proposedARR: 300 * 12 + 1000 + 175 * 12 + 500,
    });
  });

  it("with no upsells, equals the contact's own proposed figures", () => {
    const revenue = computeContactRevenue(contact({ contact_services: [svc('retainer', 'proposed', 'monthly', 300)] }));
    expect(contactProposedTotals(revenue, [])).toEqual({ proposedMRR: 300, proposedARR: 3600 });
  });
});

describe('aggregateUpsells', () => {
  it('leaves out upsells on contacts outside the active pipeline', () => {
    const byId = new Map([
      ['a', { status: 'client' }],
      ['l', { status: 'lost' }],
      ['c', { status: 'cold' }],
      ['s', { status: 'esign_signer' }],
    ]);
    const rows: UpsellForRollup[] = [
      { status: 'open', cadence: 'monthly', est_amount: 175, contact_id: 'a' },
      { status: 'open', cadence: 'monthly', est_amount: 999, contact_id: 'l' },
      { status: 'open', cadence: 'monthly', est_amount: 999, contact_id: 'c' },
      { status: 'open', cadence: 'monthly', est_amount: 999, contact_id: 's' },
    ];
    expect(aggregateUpsells(rows, byId)).toEqual({ proposedMRR: 175, proposedARR: 2100, proposedAnnual: 0, proposedOneTime: 0 });
  });

  it('counts an upsell whose contact is not in the map', () => {
    const rows: UpsellForRollup[] = [{ status: 'pitched', cadence: 'annual', est_amount: 1500, contact_id: 'missing' }];
    expect(aggregateUpsells(rows, new Map())).toEqual({ proposedMRR: 0, proposedARR: 1500, proposedAnnual: 1500, proposedOneTime: 0 });
  });
});
