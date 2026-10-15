import { timestampToDateInput } from '@/lib/dates';
import { CLIENT_LIKE_STATUSES, isActivePipelineStatus, isWonStatus, type ContactStatusKey } from '@/lib/contactStatus';
import { isAccepted, num, oneTimeAmountFor } from '@/lib/revenue';
import { monthLabel, monthsBetween, monthsNewestFirst } from './months';

/**
 * Every figure on the marketing page, as pure functions over rows already read. Revenue
 * rules come from `@/lib/revenue` (cadence drives every bucket, a `one_time` contact
 * reroutes its accepted quotes to one-time); this module adds the marketing views of them.
 *
 * Two bases, and every surface reading this must say which it uses, or the two read as a
 * contradiction:
 *  - EVENTS per month (the Monthly table, the goal cards, the Overview chart): a lead counts
 *    in the month it arrived, a win in the month of `client_since`, whenever the lead came in.
 *  - a COHORT (the source table): the leads that arrived in the range, wherever they got to.
 * A client who arrived last year and signed this year is a win in the first and not in the
 * second, and neither number is wrong.
 */

/** The quote fields the math reads (`contact_services`). */
export interface MarketingQuote {
  service_type: string;
  state: string;
  cadence: string;
  amount: number | string | null;
}

/** The contact fields the math reads, with its quotes joined on. */
export interface MarketingContact {
  id: string;
  created_at: string;
  submitted_at: string | null;
  status: string;
  source: string;
  client_since: string | null;
  contact_services: readonly MarketingQuote[];
}

/** A `monthly_goals` row as the math reads it. A NULL target is "no target", never 0. */
export interface GoalRow {
  month: string;
  ad_spend: number | string | null;
  new_leads_target: number | null;
  closed_clients_target: number | null;
}

/** The stage that earns recurring revenue. */
const ACTIVE_CLIENT: ContactStatusKey = 'client';

const isActiveClient = (c: { status: string }) => c.status === ACTIVE_CLIENT;
const isCustomer = (c: { status: string }) => (CLIENT_LIKE_STATUSES as readonly string[]).includes(c.status);
const isProposed = (r: MarketingQuote) => r.state === 'proposed';
/** Recurring engagement: monthly or annual cadence. */
const isRecurringCadence = (r: MarketingQuote) => r.cadence === 'monthly' || r.cadence === 'annual';
/** A recurring quote's annual value; a one-time quote adds 0 to ARR. */
const annualized = (r: MarketingQuote): number =>
  r.cadence === 'monthly' ? num(r.amount) * 12 : r.cadence === 'annual' ? num(r.amount) : 0;

/**
 * Won, the ONE definition shared by the Monthly table, the goal cards, the chart, the source
 * table and the goal builder. Two definitions once drifted and showed different actuals
 * against the same target. A won status (src/lib/contactStatus.ts WON_STATUSES: paying, or
 * paid and since left) with a `client_since`, which a former client keeps, so they still
 * count in the month they were won.
 */
export const isWonContact = (c: Pick<MarketingContact, 'status' | 'client_since'>): boolean =>
  !!c.client_since && isWonStatus(c.status);

/** A contact's source; a missing one counts as 'other', the same fallback everywhere. */
export const sourceOf = (c: { source: string | null }): string => c.source || 'other';

/**
 * The 'YYYY-MM' a contact arrived in, IN THE VIEWER'S ZONE: the ONE definition of a lead's
 * date. `submitted_at` (when the lead actually arrived, if earlier than the row) comes
 * first, then the row's own `created_at`. The month is taken from the local calendar day,
 * not by slicing the UTC string, which would move a lead that arrived on the last evening
 * of a month into the next one while the range picker reads local months. A second copy of
 * this chain is how one surface starts counting a contact its neighbour does not.
 */
export function leadMonth(c: Pick<MarketingContact, 'submitted_at' | 'created_at'>): string | null {
  const day = timestampToDateInput(c.submitted_at ?? c.created_at);
  return day ? day.slice(0, 7) : null;
}

/** The month a won contact was won in (`client_since` is a date, so it slices safely). */
const wonMonth = (c: Pick<MarketingContact, 'client_since'>): string => String(c.client_since).slice(0, 7);

const inRange = (ym: string | null, from: string, to: string): ym is string => ym != null && ym >= from && ym <= to;

// ── Revenue (the Revenue tab and the Overview's monthly recurring figure) ──────

export interface RevenueTotals {
  /** Accepted monthly quotes on active clients. */
  totalMRR: number;
  /** Active recurring: monthly x 12 plus annual. One-time cadence is never in it. */
  totalARR: number;
  /** Proposed recurring on active-pipeline contacts, annualized. */
  pipelineARR: number;
  /** Proposed monthly quotes on active-pipeline contacts. */
  proposedMRR: number;
  /** See oneTimeAmountFor: accepted one-time cadence, plus every accepted quote on a one_time contact. */
  oneTimeRevenue: number;
  /** Active clients holding at least one accepted recurring quote. */
  recurringClientsCount: number;
}

/** Every revenue scalar in one walk. serviceRevenueRows splits the same predicates per service. */
export function aggregateRevenue(contacts: readonly MarketingContact[]): RevenueTotals {
  const t: RevenueTotals = { totalMRR: 0, totalARR: 0, pipelineARR: 0, proposedMRR: 0, oneTimeRevenue: 0, recurringClientsCount: 0 };
  for (const c of contacts) {
    const rows = c.contact_services;
    if (isActiveClient(c)) {
      if (rows.some((r) => isAccepted(r) && isRecurringCadence(r))) t.recurringClientsCount += 1;
      for (const r of rows) {
        if (!isAccepted(r)) continue;
        if (r.cadence === 'monthly') t.totalMRR += num(r.amount);
        t.totalARR += annualized(r);
      }
    }
    // An inclusion set: a parked, lost or signer-only contact is not live pipeline, and a
    // status added later is not either until it is put in the set.
    if (isActivePipelineStatus(c.status)) {
      for (const r of rows) {
        if (!isProposed(r)) continue;
        if (r.cadence === 'monthly') t.proposedMRR += num(r.amount);
        t.pipelineARR += annualized(r);
      }
    }
    t.oneTimeRevenue += oneTimeAmountFor(c);
  }
  return t;
}

export interface ServiceRevenueRow {
  /** The `service_types` key. */
  service: string;
  /** Active clients holding an accepted recurring quote for this service, once per contact. */
  clients: number;
  mrr: number;
  arr: number;
  oneTime: number;
  proposedMRR: number;
  proposedARR: number;
  proposedOneTime: number;
}

export type ServiceRevenueTotals = Omit<ServiceRevenueRow, 'service' | 'clients'>;

/**
 * One row per service type, active against proposed. Uses aggregateRevenue's exact
 * predicates, so the rows SUM to its scalars; that tie-out is the point of the table:
 *   sum mrr = totalMRR, sum arr = totalARR, sum oneTime = oneTimeRevenue,
 *   sum proposedMRR = proposedMRR, sum proposedARR = pipelineARR.
 * Rows follow `order` (the service_types keys by sort_order); a key outside it is still
 * appended, so no row is ever dropped.
 */
export function serviceRevenueRows(contacts: readonly MarketingContact[], order: readonly string[] = []): ServiceRevenueRow[] {
  const byService = new Map<string, ServiceRevenueRow>();
  const rowFor = (service: string): ServiceRevenueRow => {
    let r = byService.get(service);
    if (!r) {
      r = { service, clients: 0, mrr: 0, arr: 0, oneTime: 0, proposedMRR: 0, proposedARR: 0, proposedOneTime: 0 };
      byService.set(service, r);
    }
    return r;
  };

  for (const c of contacts) {
    const isClient = isActiveClient(c);
    const isOneTimeContact = c.status === 'one_time';
    const inPipeline = isActivePipelineStatus(c.status);
    // Two accepted quotes for one service on two businesses are still ONE client of it.
    const recurringServices = new Set<string>();

    for (const r of c.contact_services) {
      const target = rowFor(r.service_type);
      if (isAccepted(r)) {
        // The same rule as oneTimeAmountFor: one-time cadence, or any accepted quote on a
        // one_time contact.
        if (r.cadence === 'one_time' || isOneTimeContact) target.oneTime += num(r.amount);
        if (isClient) {
          if (r.cadence === 'monthly') target.mrr += num(r.amount);
          target.arr += annualized(r);
          if (isRecurringCadence(r)) recurringServices.add(r.service_type);
        }
      } else if (isProposed(r) && inPipeline) {
        if (r.cadence === 'monthly') target.proposedMRR += num(r.amount);
        // Cadence only: the one_time-contact reroute is a rule for accepted revenue, not
        // for a forecast.
        if (r.cadence === 'one_time') target.proposedOneTime += num(r.amount);
        target.proposedARR += annualized(r);
      }
    }
    for (const s of recurringServices) rowFor(s).clients += 1;
  }

  const known = order.filter((s) => byService.has(s));
  const extra = [...byService.keys()].filter((s) => !order.includes(s)).sort();
  return [...known, ...extra].map((s) => byService.get(s)!);
}

/** Column-wise sum of any slice of rows: the family subtotals and the grand total. */
export function sumServiceRows(rows: readonly ServiceRevenueTotals[]): ServiceRevenueTotals {
  return rows.reduce<ServiceRevenueTotals>(
    (acc, r) => ({
      mrr: acc.mrr + r.mrr,
      arr: acc.arr + r.arr,
      oneTime: acc.oneTime + r.oneTime,
      proposedMRR: acc.proposedMRR + r.proposedMRR,
      proposedARR: acc.proposedARR + r.proposedARR,
      proposedOneTime: acc.proposedOneTime + r.proposedOneTime,
    }),
    { mrr: 0, arr: 0, oneTime: 0, proposedMRR: 0, proposedARR: 0, proposedOneTime: 0 },
  );
}

/** Accepted monthly quotes on an active client: that client's share of MRR. */
export function quotedMrrFor(c: MarketingContact): number {
  if (!isActiveClient(c)) return 0;
  return c.contact_services.filter((r) => isAccepted(r) && r.cadence === 'monthly').reduce((s, r) => s + num(r.amount), 0);
}

// ── Leads and wins by month (events) ───────────────────────────────────────────

export function leadsAndWonByMonth(contacts: readonly MarketingContact[]): {
  leadsByMonth: Map<string, number>;
  wonByMonth: Map<string, number>;
} {
  const leadsByMonth = new Map<string, number>();
  const wonByMonth = new Map<string, number>();
  for (const c of contacts) {
    const arrived = leadMonth(c);
    if (arrived) leadsByMonth.set(arrived, (leadsByMonth.get(arrived) ?? 0) + 1);
    if (isWonContact(c)) {
      const ym = wonMonth(c);
      wonByMonth.set(ym, (wonByMonth.get(ym) ?? 0) + 1);
    }
  }
  return { leadsByMonth, wonByMonth };
}

export interface MonthlyMarketingRow {
  month: string;
  monthLabel: string;
  adSpend: number;
  leads: number;
  closed: number;
  /** Spend over leads; 0 when there were none. */
  cpl: number;
  /** Spend over wins; 0 when there were none. */
  cac: number;
  /** Wins over leads, as a percentage to one decimal. */
  convPct: number;
  newLeadsTarget: number | null;
  closedClientsTarget: number | null;
}

/**
 * The All time preset's lookback, and the longest range the picker accepts. The picker
 * refuses anything longer with a message; this module never trims a range, because a
 * trimmed range would drop its earliest months from the table while the fees and the goal
 * builder's pace still counted them.
 */
export const MAX_RANGE_MONTHS = 240;

/** One row per month in [from, to], newest first, every month of it: spend and targets from goals, leads and wins from contacts. */
export function monthlyMarketing(
  contacts: readonly MarketingContact[],
  goals: readonly GoalRow[],
  fromMonth: string,
  toMonth: string,
): MonthlyMarketingRow[] {
  const goalByMonth = new Map(goals.map((g) => [g.month, g]));
  const { leadsByMonth, wonByMonth } = leadsAndWonByMonth(contacts);
  return monthsNewestFirst(fromMonth, toMonth, monthsBetween(fromMonth, toMonth)).map((month) => {
    const g = goalByMonth.get(month);
    const adSpend = num(g?.ad_spend);
    const leads = leadsByMonth.get(month) ?? 0;
    const closed = wonByMonth.get(month) ?? 0;
    return {
      month,
      monthLabel: monthLabel(month),
      adSpend,
      leads,
      closed,
      cpl: leads > 0 ? Math.round(adSpend / leads) : 0,
      cac: closed > 0 ? Math.round(adSpend / closed) : 0,
      convPct: leads > 0 ? Math.round((closed / leads) * 1000) / 10 : 0,
      newLeadsTarget: g?.new_leads_target ?? null,
      closedClientsTarget: g?.closed_clients_target ?? null,
    };
  });
}

export interface MarketingTotals {
  adSpend: number;
  leads: number;
  closed: number;
  cpl: number;
  cac: number;
  convPct: number;
  /** NULL when not one month in the range carries that target: "no target", not a target of 0. */
  leadsTarget: number | null;
  closedTarget: number | null;
}

/** Sums only the months that carry a target; null when none does. */
function sumTargets(rows: readonly MonthlyMarketingRow[], pick: (r: MonthlyMarketingRow) => number | null): number | null {
  const set = rows.map(pick).filter((v): v is number => v != null);
  return set.length > 0 ? set.reduce((s, v) => s + v, 0) : null;
}

export function totalMarketing(rows: readonly MonthlyMarketingRow[]): MarketingTotals {
  const adSpend = rows.reduce((s, r) => s + r.adSpend, 0);
  const leads = rows.reduce((s, r) => s + r.leads, 0);
  const closed = rows.reduce((s, r) => s + r.closed, 0);
  return {
    adSpend,
    leads,
    closed,
    cpl: leads > 0 ? Math.round(adSpend / leads) : 0,
    cac: closed > 0 ? Math.round(adSpend / closed) : 0,
    convPct: leads > 0 ? Math.round((closed / leads) * 1000) / 10 : 0,
    leadsTarget: sumTargets(rows, (r) => r.newLeadsTarget),
    closedTarget: sumTargets(rows, (r) => r.closedClientsTarget),
  };
}

// ── What a won client is worth (the goal builder's input) ─────────────────────

export interface WonCohortFees {
  wins: number;
  withFees: number;
  /** Won contacts with no accepted quote: reported, never averaged in as $0. */
  withoutFees: number;
  recurringWins: number;
  oneTimeWins: number;
  avgRecurringARR: number;
  avgOneTime: number;
}

export const NO_FEES: WonCohortFees = {
  wins: 0, withFees: 0, withoutFees: 0, recurringWins: 0, oneTimeWins: 0, avgRecurringARR: 0, avgOneTime: 0,
};

/** One won contact's accepted value, split recurring (ARR) and one-time, with the one_time reroute. */
function wonValue(c: MarketingContact): { recurring: number; oneTime: number; priced: boolean } {
  const accepted = c.contact_services.filter(isAccepted);
  const contactIsOneTime = c.status === 'one_time';
  const recurring = contactIsOneTime ? 0 : accepted.filter(isRecurringCadence).reduce((s, r) => s + annualized(r), 0);
  return { recurring, oneTime: oneTimeAmountFor(c), priced: accepted.length > 0 };
}

/**
 * What one new client is worth, measured over the clients won (client_since) in the window.
 * Grain is the CONTACT: a client with two services is one client worth the sum, not two
 * clients worth the average, which would make the price of a line item look like the price
 * of a client. Recurring and one-time are measured separately and a client can be in both.
 */
export function wonCohortFees(contacts: readonly MarketingContact[], fromMonth: string, toMonth: string): WonCohortFees {
  const cohort = contacts.filter((c) => isWonContact(c) && inRange(wonMonth(c), fromMonth, toMonth));
  let withFees = 0;
  let recurringWins = 0;
  let oneTimeWins = 0;
  let recurringTotal = 0;
  let oneTimeTotal = 0;
  for (const c of cohort) {
    const v = wonValue(c);
    if (!v.priced) continue;
    withFees += 1;
    if (v.recurring > 0) {
      recurringWins += 1;
      recurringTotal += v.recurring;
    }
    if (v.oneTime > 0) {
      oneTimeWins += 1;
      oneTimeTotal += v.oneTime;
    }
  }
  return {
    wins: cohort.length,
    withFees,
    withoutFees: cohort.length - withFees,
    recurringWins,
    oneTimeWins,
    avgRecurringARR: recurringWins > 0 ? Math.round(recurringTotal / recurringWins) : 0,
    avgOneTime: oneTimeWins > 0 ? Math.round(oneTimeTotal / oneTimeWins) : 0,
  };
}

// ── What each source was worth (cohort) ─────────────────────────────────────────

export interface SourceValueRow {
  /** The stored `contacts.source` key, not a label. */
  source: string;
  leads: number;
  wins: number;
  recurringARR: number;
  oneTime: number;
  /** Recurring ARR plus one-time over leads: a blended figure, for ranking sources. */
  valuePerLead: number;
}

/**
 * What each source was worth in dollars, over the leads that ARRIVED in the range. A count
 * of wins ranks a source that sends many cheap leads above one that sends a few valuable
 * ones; this ranks by money. Recurring is ARR and one-time is separate, and the two are only
 * added in `valuePerLead`. A source that sent leads and won nothing keeps its row: that is
 * the finding.
 */
export function sourceValue(contacts: readonly MarketingContact[], fromMonth: string, toMonth: string): SourceValueRow[] {
  const bySource = new Map<string, SourceValueRow>();
  for (const c of contacts) {
    if (!inRange(leadMonth(c), fromMonth, toMonth)) continue;
    const source = sourceOf(c);
    let row = bySource.get(source);
    if (!row) {
      row = { source, leads: 0, wins: 0, recurringARR: 0, oneTime: 0, valuePerLead: 0 };
      bySource.set(source, row);
    }
    row.leads += 1;
    if (!isWonContact(c)) continue;
    row.wins += 1;
    const v = wonValue(c);
    row.recurringARR += v.recurring;
    row.oneTime += v.oneTime;
  }
  const total = (r: SourceValueRow) => r.recurringARR + r.oneTime;
  return [...bySource.values()]
    .map((r) => ({ ...r, valuePerLead: r.leads > 0 ? Math.round(total(r) / r.leads) : 0 }))
    .sort((a, b) => total(b) - total(a) || b.leads - a.leads);
}

/** Leads that arrived in the range, by source, most first. The chart beside the source table. */
export function leadsBySource(contacts: readonly MarketingContact[], fromMonth: string, toMonth: string): { source: string; leads: number }[] {
  const counts = new Map<string, number>();
  for (const c of contacts) {
    if (!inRange(leadMonth(c), fromMonth, toMonth)) continue;
    const source = sourceOf(c);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, leads]) => ({ source, leads })).sort((a, b) => b.leads - a.leads);
}

/** The leads in a range from one source: the people behind a source row. */
export function leadsFrom<C extends MarketingContact>(contacts: readonly C[], source: string, fromMonth: string, toMonth: string): C[] {
  return contacts.filter((c) => sourceOf(c) === source && inRange(leadMonth(c), fromMonth, toMonth));
}

// ── The Overview ──────────────────────────────────────────────────────────────

export interface NeedsFixing<C extends MarketingContact> {
  /** Customers with no accepted price above zero: they add $0 to every revenue figure. */
  noPrice: C[];
  /** Customers with no client-since date: missing from Won in every month. */
  noSince: C[];
  /** Accepted monthly quotes on active clients. */
  quotedMRR: number;
}

/**
 * The gaps that make the numbers wrong, each with the people behind it. Both lists hold
 * customers only (client or one_time): a lead with no price is not a gap. A former client
 * with no start date is in neither list, and so is missing from Won without being flagged.
 */
export function needsFixing<C extends MarketingContact>(contacts: readonly C[]): NeedsFixing<C> {
  const customers = contacts.filter(isCustomer);
  return {
    noPrice: customers.filter((c) => !c.contact_services.some((r) => isAccepted(r) && num(r.amount) > 0)),
    noSince: customers.filter((c) => !c.client_since),
    quotedMRR: contacts.reduce((s, c) => s + quotedMrrFor(c), 0),
  };
}

export interface MarketingMonthPoint {
  month: string;
  leads: number;
  won: number;
}

/** One point per month for the Overview chart, from the same counts as the Monthly table. */
export function marketingSeries(contacts: readonly MarketingContact[], months: readonly string[]): MarketingMonthPoint[] {
  const { leadsByMonth, wonByMonth } = leadsAndWonByMonth(contacts);
  return months.map((month) => ({ month, leads: leadsByMonth.get(month) ?? 0, won: wonByMonth.get(month) ?? 0 }));
}

/**
 * Height of one chart bar, as a percent of the tallest. null = no data that month (no bar);
 * 0 = a real zero (a hairline); a small positive value floors at 8% so it stays visible.
 */
export function sparkBarHeight(v: number | null, max: number): number | null {
  if (v == null) return null;
  if (v <= 0 || max <= 0) return 0;
  return Math.max(8, Math.round((v / max) * 100));
}
