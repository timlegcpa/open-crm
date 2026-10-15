import { describe, it, expect } from 'vitest';
import { MAX_PLAN_MONTHS, planGoal, type MeasuredPace } from '../lib/goalPlanner';
import { addMonths, monthsBetween } from '../lib/months';

/** A funnel that is exactly on pace, so every lever should report today's value. */
const onPace: MeasuredPace = {
  leadsPerMonth: 10,
  wonPerMonth: 4,
  convPct: 40,
  avgValue: 2500,
};

/** Half the close rate, so the plan needs more of something. */
const behind: MeasuredPace = {
  leadsPerMonth: 10,
  wonPerMonth: 2,
  convPct: 20,
  avgValue: 2000,
};

describe('planGoal: refusals', () => {
  it('refuses a deadline that is not in the future', () => {
    const r = planGoal({ targetDollars: 50000, months: 0 }, onPace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/future/i);
  });

  it('refuses a target of zero', () => {
    const r = planGoal({ targetDollars: 0, months: 6 }, onPace);
    expect(r.ok).toBe(false);
  });

  it('refuses when no won client carries a price, rather than dividing by zero', () => {
    const r = planGoal(
      { targetDollars: 50000, months: 6 },
      { ...onPace, avgValue: 0 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/average client value/i);
  });

  // The dialog writes one row per planned month, so a plan past the horizon is refused
  // rather than planned over more months than it writes.
  it('plans up to 120 months and refuses a deadline past that', () => {
    expect(planGoal({ targetDollars: 50000, months: MAX_PLAN_MONTHS }, onPace).ok).toBe(true);
    const r = planGoal({ targetDollars: 50000, months: MAX_PLAN_MONTHS + 1 }, onPace);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/within 120 months/);
  });

  it('never returns Infinity or NaN on any zero input', () => {
    const zeroes: MeasuredPace = { leadsPerMonth: 0, wonPerMonth: 0, convPct: 0, avgValue: 0 };
    const r = planGoal({ targetDollars: 1000, months: 12 }, zeroes);
    expect(r.ok).toBe(false);
  });
});

describe('planGoal: a funnel already on pace', () => {
  const r = planGoal({ targetDollars: 50000, months: 5 }, onPace);

  it('solves the client count and the monthly wins', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 50,000 / 2,500 = 20 clients, over 5 months = 4 a month.
    expect(r.plan.clientsNeeded).toBe(20);
    expect(r.plan.requiredWonPerMonth).toBe(4);
    // 4 wins a month at a 40% close rate needs 10 leads a month.
    expect(r.plan.requiredLeadsPerMonth).toBe(10);
  });

  it('reports it as on pace with no shortfall', () => {
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.projectedDollars).toBe(50000);
    expect(r.plan.shortfallDollars).toBe(0);
    expect(r.plan.onPace).toBe(true);
  });

  it('returns the measured numbers on every lever, since nothing has to change', () => {
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.levers).toEqual({ leadsPerMonth: 10, convPct: 40, avgValue: 2500 });
  });
});

describe('planGoal: a funnel behind pace', () => {
  const r = planGoal({ targetDollars: 60000, months: 6 }, behind);

  it('sizes the gap in dollars', () => {
    if (!r.ok) throw new Error('expected a plan');
    // 2 wins a month x 6 months x $2,000 = $24,000 against a $60,000 target.
    expect(r.plan.projectedDollars).toBe(24000);
    expect(r.plan.shortfallDollars).toBe(36000);
    expect(r.plan.onPace).toBe(false);
  });

  it('prices all three levers independently', () => {
    if (!r.ok) throw new Error('expected a plan');
    // 30 clients over 6 months = 5 a month. At today's 20% close rate that is
    // 25 leads a month; at today's 10 leads it is a 50% close rate; at today's
    // 2 wins a month it is $5,000 a client.
    expect(r.plan.levers).toEqual({ leadsPerMonth: 25, convPct: 50, avgValue: 5000 });
  });
});

describe('planGoal: targets written to smallint columns', () => {
  it('ceils a fractional monthly target instead of rounding it down', () => {
    // 10,000 / 3,000 = 3.33 -> 4 clients, over 3 months = 1.33 a month.
    const r = planGoal(
      { targetDollars: 10000, months: 3 },
      { leadsPerMonth: 8, wonPerMonth: 1, convPct: 25, avgValue: 3000 },
    );
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.clientsNeeded).toBe(4);
    expect(r.plan.requiredWonPerMonth).toBe(1.3);
    // Rounding 1.33 down to 1 sets a target that cannot reach 4 clients.
    expect(r.plan.monthlyTarget.won).toBe(2);
    // 1.33 wins at 25% = 5.33 leads a month.
    expect(r.plan.monthlyTarget.leads).toBe(6);
  });
});

describe('planGoal: levers the measured data cannot answer', () => {
  it('leaves the lead lever null when nothing has ever converted', () => {
    const r = planGoal(
      { targetDollars: 10000, months: 5 },
      { leadsPerMonth: 12, wonPerMonth: 0, convPct: 0, avgValue: 2000 },
    );
    if (!r.ok) throw new Error('expected a plan');
    // No close rate means "how many leads" has no answer from this data.
    expect(r.plan.requiredLeadsPerMonth).toBeNull();
    expect(r.plan.monthlyTarget.leads).toBeNull();
    expect(r.plan.levers.leadsPerMonth).toBeNull();
    // The value lever needs a win rate too.
    expect(r.plan.levers.avgValue).toBeNull();
    // But the conversion lever is answerable: 1 win a month out of 12 leads.
    expect(r.plan.levers.convPct).toBeGreaterThan(0);
    // The win target still computes, because it never needed the funnel.
    expect(r.plan.monthlyTarget.won).toBe(1);
  });

  it('leaves the conversion lever null when there are no leads to convert', () => {
    const r = planGoal(
      { targetDollars: 10000, months: 5 },
      { leadsPerMonth: 0, wonPerMonth: 2, convPct: 0, avgValue: 2000 },
    );
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.levers.convPct).toBeNull();
  });
});

describe('monthsBetween', () => {
  it('counts the target month itself', () => {
    expect(monthsBetween('2026-09', '2026-09')).toBe(1);
  });

  it('counts across a year boundary', () => {
    expect(monthsBetween('2026-09', '2027-06')).toBe(10);
  });

  it('returns 0 for a month already past, which planGoal refuses', () => {
    expect(monthsBetween('2026-09', '2026-08')).toBe(0);
    expect(planGoal({ targetDollars: 1, months: 0 }, onPace).ok).toBe(false);
  });
});

describe('addMonths', () => {
  it('steps within a year and pads the month', () => {
    // The dialog's default deadline: five months out from today.
    expect(addMonths('2026-09', 5)).toBe('2027-02');
    expect(addMonths('2026-01', 8)).toBe('2026-09');
    expect(addMonths('2026-09', 0)).toBe('2026-09');
  });

  it('wraps December in both directions, which is the whole reason this exists', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-12', 13)).toBe('2028-01');
    expect(addMonths('2027-02', -14)).toBe('2025-12');
  });

  it('hands back a malformed month untouched rather than inventing one', () => {
    expect(addMonths('', 1)).toBe('');
  });
});
