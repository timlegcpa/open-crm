import { parseMoneyAmount } from '@/lib/money';
import type { MonthlyGoalPatch, NewMonthlyGoal } from '../api';

/** The goal writes the dialogs make. `mutateAsync`, so every failure reaches the dialog that made it. */
export interface GoalMutations {
  createGoal: { mutateAsync: (input: NewMonthlyGoal) => Promise<unknown> };
  updateGoal: { mutateAsync: (vars: { id: string; patch: MonthlyGoalPatch }) => Promise<unknown> };
}

/** The largest value a target column (smallint) holds. */
const MAX_TARGET = 32767;

/**
 * A strict positive money amount (the shared rule, src/lib/money.ts): optional $, comma
 * thousands groups, at most two decimals. '-50000', '50k' and '1,2,3' are refused, never
 * read as a different number.
 */
export function parseMoney(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = parseMoneyAmount(text, { allowZero: true });
  if (n === null) return { ok: false, error: 'Enter an amount like 50000 or $50,000.' };
  if (!(n > 0)) return { ok: false, error: 'Enter a target above zero.' };
  return { ok: true, value: n };
}

/**
 * A target box: '' is "no target" (null), a whole number from 0 is a target, anything else
 * is refused with a sentence. Never `parseInt(x) || 0`, which turns an emptied box into a
 * target of zero.
 */
export function parseTarget(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false, error: 'A target is a whole number, or empty for no target.' };
  const n = Number(t);
  if (n > MAX_TARGET) return { ok: false, error: `A target can be at most ${MAX_TARGET}.` };
  return { ok: true, value: n };
}

/**
 * A dollar amount box: blank is 0, otherwise the shared strict rule with zero allowed.
 * Junk is refused, never read as 0, and a comma counts only in groups of three ('1,2,3'
 * is not 123).
 */
export function parseAmount(text: string): { ok: true; value: number } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: 0 };
  const n = parseMoneyAmount(text, { allowZero: true });
  return n === null ? { ok: false, error: 'Enter an amount like 1250 or $1,250.50.' } : { ok: true, value: n };
}

/** The number a stored target puts back in its box: empty for no target. */
export const targetText = (v: number | null): string => (v == null ? '' : String(v));
