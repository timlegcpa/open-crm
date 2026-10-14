import { isActivePipelineStatus } from '@/lib/contactStatus';

/**
 * THE revenue math, from `contact_services` (quotes) and `contact_upsells` (add-on ideas).
 * Cadence drives every bucket, never the service name:
 *   accepted monthly  -> MRR, and x12 into ARR
 *   accepted annual   -> ARR once
 *   accepted one_time -> one-time revenue, never MRR or ARR
 * A contact whose status is `one_time` reroutes every accepted quote to one-time revenue.
 * Proposed quotes are pipeline, kept apart from earned figures.
 *
 * The types are structural (the fields read, nothing more), so a row from any query fits.
 * PostgREST returns numeric(15,2) as a string: every amount goes through `num`.
 */

/** The fields of a `contact_services` row the math reads. */
export interface QuoteForRevenue {
  state: string;
  cadence: string;
  amount: number | string | null;
}

/** A contact with its quotes embedded (`contact_services(*)`). A missing array means none. */
export interface ContactForRevenue {
  status: string;
  contact_services?: readonly QuoteForRevenue[] | null;
}

/** The fields of a `contact_upsells` row the math reads. */
export interface UpsellForRollup {
  status: string;
  cadence: string;
  est_amount: number | string | null;
  contact_id?: string;
}

/** A money value from the database as a number: null, empty and unparseable are 0. */
export function num(value: number | string | null | undefined): number {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export const rowsOf = (contact: ContactForRevenue): readonly QuoteForRevenue[] => contact.contact_services ?? [];
export const isAccepted = (row: QuoteForRevenue): boolean => row.state === 'accepted';

/**
 * One-time revenue for a contact: accepted one_time-cadence quotes, plus every accepted
 * quote when the contact itself is `one_time`. Counted once even when both hold.
 */
export function oneTimeAmountFor(contact: ContactForRevenue): number {
  const contactIsOneTime = contact.status === 'one_time';
  return rowsOf(contact)
    .filter((r) => isAccepted(r) && (r.cadence === 'one_time' || contactIsOneTime))
    .reduce((sum, r) => sum + num(r.amount), 0);
}

export interface ContactRevenue {
  /** Accepted monthly quotes. */
  mrr: number;
  /** MRR x 12 plus every accepted annual quote. */
  arr: number;
  /** Proposed monthly x 12 plus proposed annual. Upsells are not in it (see contactProposedTotals). */
  proposedAnnualized: number;
  /** Proposed monthly quotes. Upsells are not in it. */
  proposedMRR: number;
  /** See oneTimeAmountFor. Never part of MRR or ARR. */
  oneTimeTotal: number;
}

/**
 * A contact's revenue from its own quotes, summed across the person and every business.
 * Upsells are left out so a list of contacts never needs one upsell query per row; a
 * surface showing one contact adds them with contactProposedTotals.
 */
export function computeContactRevenue(contact: ContactForRevenue): ContactRevenue {
  const rows = rowsOf(contact);
  const contactIsOneTime = contact.status === 'one_time';
  const sum = (pick: (r: QuoteForRevenue) => boolean) => rows.reduce((s, r) => (pick(r) ? s + num(r.amount) : s), 0);

  const mrr = contactIsOneTime ? 0 : sum((r) => isAccepted(r) && r.cadence === 'monthly');
  const acceptedAnnual = contactIsOneTime ? 0 : sum((r) => isAccepted(r) && r.cadence === 'annual');
  const proposedMRR = sum((r) => r.state === 'proposed' && r.cadence === 'monthly');
  // Only annual cadence adds on top of monthly x 12: a proposed one-time quote is not
  // recurring pipeline, and folding it in would disagree with every rollup.
  const proposedAnnualized = proposedMRR * 12 + sum((r) => r.state === 'proposed' && r.cadence === 'annual');

  return { mrr, arr: mrr * 12 + acceptedAnnual, proposedAnnualized, proposedMRR, oneTimeTotal: oneTimeAmountFor(contact) };
}

export interface UpsellProposed {
  /** Monthly upsells. */
  proposedMRR: number;
  /** Monthly x 12 plus annual. */
  proposedARR: number;
  /** Annual upsells alone. */
  proposedAnnual: number;
  /** One-time upsells, never part of ARR. */
  proposedOneTime: number;
}

/**
 * Proposed figures from upsells. Only `open` and `pitched` count: a `won` upsell has already
 * become a quote (counted there, so summing it here would count it twice) and `passed` is
 * dropped.
 */
export function upsellProposedTotals(upsells: readonly UpsellForRollup[]): UpsellProposed {
  let proposedMRR = 0;
  let proposedARR = 0;
  // Summed directly rather than recovered as proposedARR - proposedMRR * 12: that
  // subtraction is not exact in floating point and leaves a tiny residue that reads as a
  // real amount.
  let proposedAnnual = 0;
  let proposedOneTime = 0;
  for (const u of upsells) {
    if (u.status !== 'open' && u.status !== 'pitched') continue;
    const amount = num(u.est_amount);
    if (u.cadence === 'monthly') {
      proposedMRR += amount;
      proposedARR += amount * 12;
    } else if (u.cadence === 'annual') {
      proposedARR += amount;
      proposedAnnual += amount;
    } else if (u.cadence === 'one_time') {
      proposedOneTime += amount;
    }
  }
  return { proposedMRR, proposedARR, proposedAnnual, proposedOneTime };
}

/**
 * One contact's proposed pipeline including its upsells: what a record shows as Proposed
 * MRR and ARR. One function, so two surfaces cannot disagree.
 */
export function contactProposedTotals(
  revenue: ContactRevenue,
  upsells: readonly UpsellForRollup[],
): { proposedMRR: number; proposedARR: number } {
  const fromUpsells = upsellProposedTotals(upsells);
  return {
    proposedMRR: revenue.proposedMRR + fromUpsells.proposedMRR,
    proposedARR: revenue.proposedAnnualized + fromUpsells.proposedARR,
  };
}

/**
 * Upsells across every contact, counting only those on an active-pipeline contact. An
 * upsell whose contact is not in the map still counts (it cannot be shown to be inactive).
 */
export function aggregateUpsells(
  upsells: readonly UpsellForRollup[],
  contactsById: ReadonlyMap<string, { status: string }>,
): UpsellProposed {
  return upsellProposedTotals(
    upsells.filter((u) => {
      const contact = u.contact_id ? contactsById.get(u.contact_id) : undefined;
      return !contact || isActivePipelineStatus(contact.status);
    }),
  );
}
