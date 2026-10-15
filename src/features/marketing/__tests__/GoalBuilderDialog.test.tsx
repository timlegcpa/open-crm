import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { todayISODate } from '@/lib/format';
import type { MonthlyGoal } from '../api';
import { GoalBuilderDialog } from '../components/GoalBuilderDialog';
import type { MonthlyMarketingRow, WonCohortFees } from '../lib/metrics';

/**
 * Rendered directly against the inputs the page passes. Pins the numbers the dialog states
 * and, above all, what Apply writes.
 */

const row = (month: string, leads: number, closed: number): MonthlyMarketingRow => ({
  month,
  monthLabel: month,
  adSpend: 0,
  leads,
  closed,
  cpl: 0,
  cac: 0,
  convPct: leads > 0 ? Math.round((closed / leads) * 1000) / 10 : 0,
  newLeadsTarget: null,
  closedClientsTarget: null,
});

// 4 months, 40 leads, 16 wins: 10 leads a month, 4 wins a month, 40% close.
const MONTH_ROWS = [row('2026-09', 10, 4), row('2026-08', 10, 4), row('2026-07', 10, 4), row('2026-06', 10, 4)];
// Wins with no lead arriving in the range: no close rate, so no lead target can be sized.
const NO_LEAD_ROWS = [row('2026-09', 0, 4), row('2026-08', 0, 4), row('2026-07', 0, 4), row('2026-06', 0, 4)];

const FEES: WonCohortFees = { wins: 16, withFees: 16, withoutFees: 0, recurringWins: 16, oneTimeWins: 0, avgRecurringARR: 2500, avgOneTime: 0 };

const goal = (id: string, month: string): MonthlyGoal => ({ id, month, ad_spend: '500.00', new_leads_target: 1, closed_clients_target: 1 });

function renderDialog(over: Partial<ComponentProps<typeof GoalBuilderDialog>> = {}) {
  const createGoal = { mutateAsync: vi.fn().mockResolvedValue(undefined) };
  const updateGoal = { mutateAsync: vi.fn().mockResolvedValue(undefined) };
  render(
    <GoalBuilderDialog
      open
      onOpenChange={() => {}}
      monthRows={MONTH_ROWS}
      fees={FEES}
      rangeLabel="Year to date"
      goals={[]}
      mutations={{ createGoal, updateGoal }}
      {...over}
    />,
  );
  return { createGoal, updateGoal };
}

const setTarget = (v: string) => fireEvent.change(screen.getByLabelText('Target'), { target: { value: v } });
const apply = () => {
  fireEvent.click(screen.getByRole('button', { name: /Apply to monthly targets/i }));
  fireEvent.click(screen.getByRole('button', { name: /Write the targets/i }));
};

describe('GoalBuilderDialog', () => {
  it('shows the measured pace it solves against, not an assumed one', () => {
    renderDialog();
    expect(screen.getByText('Leads / mo')).toBeInTheDocument();
    expect(screen.getByText('10.0')).toBeInTheDocument();
    expect(screen.getByText('4.0')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('states plainly that ad spend is not an input', () => {
    renderDialog();
    expect(screen.getByText(/Ad spend is not an input/i)).toBeInTheDocument();
  });

  it('asks for a target before showing a plan', () => {
    renderDialog();
    expect(screen.getByText(/Enter a target above zero/i)).toBeInTheDocument();
    expect(screen.queryByText('Clients needed')).not.toBeInTheDocument();
  });

  it('back-solves a target into clients needed', () => {
    renderDialog();
    setTarget('50000');
    expect(screen.getByText('Clients needed')).toBeInTheDocument();
    // 50,000 over 2,500 = 20 clients.
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('refuses to plan when no won client carries a price', () => {
    renderDialog({ fees: { ...FEES, avgRecurringARR: 0, recurringWins: 0, withFees: 0, withoutFees: 16 } });
    setTarget('50000');
    expect(screen.getByText(/no average client value/i)).toBeInTheDocument();
    expect(screen.queryByText('Clients needed')).not.toBeInTheDocument();
  });

  it('surfaces won clients that carry no accepted quote', () => {
    renderDialog({ fees: { ...FEES, withFees: 12, withoutFees: 4 } });
    expect(screen.getByText(/4 of 16 clients won in this range carry no accepted quote/i)).toBeInTheDocument();
  });

  it('confirms before writing, and never writes on the first click', () => {
    const { createGoal, updateGoal } = renderDialog();
    setTarget('50000');
    fireEvent.click(screen.getByRole('button', { name: /Apply to monthly targets/i }));
    expect(createGoal.mutateAsync).not.toHaveBeenCalled();
    expect(updateGoal.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Write the targets/i })).toBeInTheDocument();
  });

  it('creates a row per month, closes only once every month landed, and never touches ad spend', async () => {
    const onOpenChange = vi.fn();
    const { createGoal, updateGoal } = renderDialog({ onOpenChange });
    setTarget('50000');
    apply();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateGoal.mutateAsync).not.toHaveBeenCalled();
    const written = createGoal.mutateAsync.mock.calls.map((c) => c[0]);
    expect(written).toHaveLength(6);
    for (const w of written) {
      expect(w).not.toHaveProperty('ad_spend');
      // 20 clients over 6 months is 3.3 wins a month, ceiled to 4; at 40% that is 8.3 leads, ceiled to 9.
      expect(w).toMatchObject({ closed_clients_target: 4, new_leads_target: 9 });
    }
  });

  it('writes a NULL lead target when no close rate can size one, never a zero', async () => {
    const { createGoal } = renderDialog({ monthRows: NO_LEAD_ROWS });
    setTarget('50000');
    apply();
    await waitFor(() => expect(createGoal.mutateAsync).toHaveBeenCalled());
    for (const [w] of createGoal.mutateAsync.mock.calls) {
      expect(w.new_leads_target).toBeNull();
      expect(Number.isInteger(w.closed_clients_target)).toBe(true);
    }
  });

  it('stays open and says how many landed when a month fails to write', async () => {
    const onOpenChange = vi.fn();
    const { createGoal } = renderDialog({ onOpenChange });
    createGoal.mutateAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network'));
    setTarget('50000');
    apply();
    expect(await screen.findByRole('alert')).toHaveTextContent('5 of 6 months saved');
    expect(createGoal.mutateAsync).toHaveBeenCalledTimes(6);
    expect(screen.getByRole('button', { name: /Write the targets/i })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('updates an existing month instead of creating a second row for it, and says so', async () => {
    const existing = goal('g1', todayISODate().slice(0, 7));
    const { createGoal, updateGoal } = renderDialog({ goals: [existing] });
    setTarget('50000');
    fireEvent.click(screen.getByRole('button', { name: /Apply to monthly targets/i }));
    expect(screen.getByText(/overwrites the targets on 1 month/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Write the targets/i }));
    await waitFor(() => expect(updateGoal.mutateAsync).toHaveBeenCalledTimes(1));
    const createdMonths = createGoal.mutateAsync.mock.calls.map((c) => c[0].month);
    expect(createdMonths).not.toContain(existing.month);
    expect(createdMonths).toHaveLength(5);
    const [{ id, patch }] = updateGoal.mutateAsync.mock.calls[0];
    expect(id).toBe('g1');
    expect(patch).not.toHaveProperty('ad_spend');
  });

  // One $1,000 recurring win and nine one-time wins over 10 months. The recurring pace is one
  // win in ten months, not ten: projecting all ten wins at the recurring average would claim
  // $10,000 of new ARR the data never showed.
  it('paces a recurring goal on recurring wins only, not on every win', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2025-${String(i + 1).padStart(2, '0')}`, 10, 1));
    renderDialog({
      monthRows: rows,
      fees: { wins: 10, withFees: 10, withoutFees: 0, recurringWins: 1, oneTimeWins: 9, avgRecurringARR: 1000, avgOneTime: 500 },
    });
    expect(screen.getByText('Recurring wins / mo')).toBeInTheDocument();
    expect(screen.getByText('0.1')).toBeInTheDocument();
    // 1 recurring win over 100 leads.
    expect(screen.getByText('1%')).toBeInTheDocument();
    // Default deadline is 6 months: 0.1 a month x 6 x $1,000 = $600, not $6,000.
    setTarget('50000');
    expect(screen.getByText('$600')).toBeInTheDocument();
  });

  it('paces a one-time goal on one-time wins', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2025-${String(i + 1).padStart(2, '0')}`, 10, 1));
    renderDialog({
      monthRows: rows,
      fees: { wins: 10, withFees: 10, withoutFees: 0, recurringWins: 1, oneTimeWins: 9, avgRecurringARR: 1000, avgOneTime: 500 },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'One-time' }));
    expect(screen.getByText('One-time wins / mo')).toBeInTheDocument();
    expect(screen.getByText('0.9')).toBeInTheDocument();
    expect(screen.getByText('9%')).toBeInTheDocument();
  });

  it.each([
    ['-50000', /Enter an amount like/],
    ['50k', /Enter an amount like/],
    ['1,2,3', /Enter an amount like/],
    ['50000.123', /Enter an amount like/],
    ['0', /Enter a target above zero/],
  ])('refuses the target %s instead of reading it as another number', (text, message) => {
    const { createGoal } = renderDialog();
    setTarget(text);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText('Clients needed')).not.toBeInTheDocument();
    expect(createGoal.mutateAsync).not.toHaveBeenCalled();
  });

  it('reads $50,000.00 as 50000', () => {
    renderDialog();
    setTarget('$50,000.00');
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('refuses a plan whose monthly target a target column cannot hold', () => {
    const { createGoal } = renderDialog({ fees: { ...FEES, avgRecurringARR: 1 } });
    // 1,000,000 clients over 6 months is 166,667 wins a month, past 32767.
    setTarget('1000000');
    expect(screen.getByText(/more than a monthly target can hold/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply to monthly targets/i })).not.toBeInTheDocument();
    expect(createGoal.mutateAsync).not.toHaveBeenCalled();
  });
});
