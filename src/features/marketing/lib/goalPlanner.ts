/**
 * The goal builder's arithmetic: back-solve a revenue target into monthly lead and win
 * targets.
 *
 * Deliberately arithmetic only. It takes measured numbers and returns required numbers; it
 * never reads a contact, a goal row or the network, so every branch is testable against
 * hand-computed fixtures.
 *
 * WHAT IS NOT IN HERE, AND WHY: ad spend. Spend is recorded as one blended
 * `monthly_goals.ad_spend` figure a month with no channel on it, so there is no way to tell
 * which leads a dollar bought. A "spend $X to get Y clients" model over that would divide
 * real dollars by leads the dollars may not have bought. Cost per goal needs spend tagged by
 * channel first, which is a schema change.
 *
 * Every figure here is GROSS. Nothing in the app tracks a client leaving, so "new recurring
 * revenue" means added, never net.
 */

/** What kind of revenue the goal is denominated in. */
export type GoalKind = 'recurring' | 'one_time';

export interface GoalInputs {
  /**
   * New ARR for 'recurring', or one-time dollars for 'one_time'. The caller has already
   * resolved the kind into `pace.avgValue`, so this module never needs to know which one it
   * is; a `kind` field here would read as a switch no branch reads.
   */
  targetDollars: number;
  /** Months available to hit it. */
  months: number;
}

/**
 * The measured pace the plan is solved against. Every field comes from the owner's own
 * data over a chosen window, never from an assumption.
 *
 * `convPct` and `wonPerMonth` carry the same fact when both are measured over the same
 * window (leadsPerMonth x convPct/100 is about wonPerMonth), and the levers lean on that. The
 * identity is APPROXIMATE: `totalMarketing` rounds `convPct` to one decimal, so a lever
 * derived through the rate can sit a hair off the same lever derived through the win count.
 */
export interface MeasuredPace {
  leadsPerMonth: number;
  wonPerMonth: number;
  /** Won over leads, as a percentage. */
  convPct: number;
  /** ARR per recurring win, or dollars per one-time win. */
  avgValue: number;
}

/**
 * The three ways to close a gap, each holding the other two fixed. A required lead count on
 * its own says how big the hole is, not which lever is cheapest to pull.
 *
 * A lever is null when today's measurement cannot support it: no close rate means the lead
 * lever is unanswerable, no leads means the conversion lever is. Null is rendered as "not
 * enough data", never as zero.
 */
export interface GoalLevers {
  /** Leads per month needed, holding today's close rate and client value. */
  leadsPerMonth: number | null;
  /** Close rate (%) needed, holding today's lead flow and client value. */
  convPct: number | null;
  /** Average client value needed, holding today's lead flow and close rate. */
  avgValue: number | null;
}

export interface GoalPlan {
  clientsNeeded: number;
  /** Exact, for the sentence. `monthlyTarget` carries what actually gets written. */
  requiredWonPerMonth: number;
  requiredLeadsPerMonth: number | null;
  /** Whole-number targets for `monthly_goals`; both columns are smallint. */
  monthlyTarget: { leads: number | null; won: number };
  /** Dollars the current pace produces over the same horizon. */
  projectedDollars: number;
  /** Target minus projection, floored at 0. */
  shortfallDollars: number;
  onPace: boolean;
  levers: GoalLevers;
}

export type GoalResult = { ok: true; plan: GoalPlan } | { ok: false; reason: string };

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Ceil, never round, for anything written as a target. 3.2 leads a month is a target of 4:
 * rounding down sets a goal that cannot reach the number it was derived from.
 */
const ceilTarget = (n: number): number => Math.max(0, Math.ceil(n));

/**
 * The furthest deadline a plan reaches. The dialog writes one row per month, so the plan
 * and the writes share this horizon: a plan for 200 months that writes 120 would report
 * success for a partial write.
 */
export const MAX_PLAN_MONTHS = 120;

export function planGoal(inputs: GoalInputs, pace: MeasuredPace): GoalResult {
  const { targetDollars, months } = inputs;

  // Refusals, not best guesses. Each would otherwise divide by zero and hand back Infinity
  // or NaN dressed up as a plan.
  if (!(months > 0)) {
    return { ok: false, reason: 'Pick a target month in the future.' };
  }
  if (months > MAX_PLAN_MONTHS) {
    return { ok: false, reason: `Pick a target month within ${MAX_PLAN_MONTHS} months. A plan writes a target to every month up to it.` };
  }
  if (!(targetDollars > 0)) {
    return { ok: false, reason: 'Enter a target above zero.' };
  }
  if (!(pace.avgValue > 0)) {
    return {
      ok: false,
      reason:
        'No client won in this range carries a priced service, so there is no average client value to divide the target by. Widen the range, or price the won clients that have no accepted quote.',
    };
  }

  const clientsNeeded = Math.ceil(targetDollars / pace.avgValue);
  const requiredWonPerMonth = clientsNeeded / months;

  // Leads needed follows from the close rate. No measured close rate means the question has
  // no answer from this data, so say so rather than assume one.
  const convRate = pace.convPct / 100;
  const requiredLeadsPerMonth = convRate > 0 ? requiredWonPerMonth / convRate : null;

  const projectedDollars = pace.wonPerMonth * months * pace.avgValue;
  const shortfallDollars = Math.max(0, targetDollars - projectedDollars);

  const levers: GoalLevers = {
    leadsPerMonth: requiredLeadsPerMonth != null ? round1(requiredLeadsPerMonth) : null,
    convPct: pace.leadsPerMonth > 0 ? round1((requiredWonPerMonth / pace.leadsPerMonth) * 100) : null,
    avgValue: pace.wonPerMonth > 0 ? Math.round(targetDollars / (pace.wonPerMonth * months)) : null,
  };

  return {
    ok: true,
    plan: {
      clientsNeeded,
      requiredWonPerMonth: round1(requiredWonPerMonth),
      requiredLeadsPerMonth: requiredLeadsPerMonth != null ? round1(requiredLeadsPerMonth) : null,
      monthlyTarget: {
        leads: requiredLeadsPerMonth != null ? ceilTarget(requiredLeadsPerMonth) : null,
        won: ceilTarget(requiredWonPerMonth),
      },
      projectedDollars: Math.round(projectedDollars),
      shortfallDollars: Math.round(shortfallDollars),
      onPace: shortfallDollars <= 0,
      levers,
    },
  };
}
