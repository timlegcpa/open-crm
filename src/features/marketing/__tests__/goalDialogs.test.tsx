import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { todayISODate } from '@/lib/format';
import type { MonthlyGoal } from '../api';
import { AdSpendDialog } from '../components/AdSpendDialog';
import { GoalsTab } from '../components/GoalsTab';
import { parseAmount, parseMoney, parseTarget } from '../components/goalInputs';
import { addMonths, monthLabel } from '../lib/months';

const THIS_MONTH = todayISODate().slice(0, 7);
const LAST_MONTH = addMonths(THIS_MONTH, -1);

function mutations() {
  return {
    createGoal: { mutateAsync: vi.fn().mockResolvedValue(undefined) },
    updateGoal: { mutateAsync: vi.fn().mockResolvedValue(undefined) },
  };
}

/** Opens the month picker behind `label` and picks the 1st of this month (the calendar opens on it; never a future day). */
function pickThisMonth(label: string) {
  fireEvent.click(screen.getByLabelText(label));
  const name = new Date().toLocaleString('en-US', { month: 'long' });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${name} 1st,`) }));
}

const goal = (o: Partial<MonthlyGoal>): MonthlyGoal => ({
  id: 'g1',
  month: LAST_MONTH,
  ad_spend: '0.00',
  new_leads_target: null,
  closed_clients_target: null,
  ...o,
});

describe('target and amount boxes', () => {
  it('an empty target box is no target, never zero; junk is refused', () => {
    expect(parseTarget('')).toEqual({ ok: true, value: null });
    expect(parseTarget(' 0 ')).toEqual({ ok: true, value: 0 });
    expect(parseTarget('12')).toEqual({ ok: true, value: 12 });
    for (const bad of ['1.5', '-3', 'ten', '40000']) expect(parseTarget(bad).ok, bad).toBe(false);
  });

  it('an amount is refused when it is junk, never read as zero', () => {
    expect(parseAmount('1,250.50')).toEqual({ ok: true, value: 1250.5 });
    expect(parseAmount('')).toEqual({ ok: true, value: 0 });
    for (const bad of ['12abc', '-5', '1.234']) expect(parseAmount(bad).ok, bad).toBe(false);
  });
});

describe('the goal builder target (strict money)', () => {
  it('reads plain, $-prefixed and comma-grouped amounts', () => {
    expect(parseMoney('50000')).toEqual({ ok: true, value: 50000 });
    expect(parseMoney(' $50,000.50 ')).toEqual({ ok: true, value: 50000.5 });
    expect(parseMoney('$1,234,567')).toEqual({ ok: true, value: 1234567 });
  });

  it('refuses anything it would otherwise misread', () => {
    for (const bad of ['', '-50000', '50k', '1,2,3', '12,34', '5.123', '$', 'ten', '0', '0.00', '$-5']) {
      expect(parseMoney(bad).ok, bad).toBe(false);
    }
  });
});

describe('GoalsTab', () => {
  it('draws a month with no targets as "No target", not as a target of zero', () => {
    render(<GoalsTab goals={[goal({})]} contacts={[]} mutations={mutations()} />);
    const card = within(screen.getByRole('region', { name: `Goals for ${monthLabel(LAST_MONTH)}` }));
    expect(card.getAllByText('No target')).toHaveLength(2);
    expect(card.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('saves an emptied target as NULL', async () => {
    const m = mutations();
    render(<GoalsTab goals={[goal({ new_leads_target: 8, closed_clients_target: 3 })]} contacts={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: `Edit goals for ${monthLabel(LAST_MONTH)}` }));
    fireEvent.change(screen.getByLabelText('New leads target'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.updateGoal.mutateAsync).toHaveBeenCalled());
    expect(m.updateGoal.mutateAsync).toHaveBeenCalledWith({ id: 'g1', patch: { new_leads_target: null, closed_clients_target: 3 } });
  });

  it('creates a month with exactly its targets, empty boxes as NULL, no spend', async () => {
    const m = mutations();
    render(<GoalsTab goals={[]} contacts={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Set a month/ }));
    fireEvent.change(screen.getByLabelText('New clients target'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.createGoal.mutateAsync).toHaveBeenCalled());
    expect(m.createGoal.mutateAsync).toHaveBeenCalledWith({ month: THIS_MONTH, new_leads_target: null, closed_clients_target: 2 });
  });

  it('refuses a second row for a month that has one, before writing', async () => {
    const m = mutations();
    render(<GoalsTab goals={[goal({ id: 'g2', month: THIS_MONTH })]} contacts={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Set a month/ }));
    // The month box starts empty when this month is taken; a pick of the taken month is what matters.
    expect(screen.getByLabelText('Month')).toHaveTextContent('Pick a month');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a month.');
    expect(m.createGoal.mutateAsync).not.toHaveBeenCalled();
  });

  it('refuses a picked month that already has goals', () => {
    const m = mutations();
    render(<GoalsTab goals={[goal({ id: 'g2', month: THIS_MONTH })]} contacts={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Set a month/ }));
    pickThisMonth('Month');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('already has goals');
    expect(m.createGoal.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows a failed save inline and stays open', async () => {
    const m = mutations();
    m.updateGoal.mutateAsync.mockRejectedValueOnce(new Error('This month was not saved. Reload and try again.'));
    render(<GoalsTab goals={[goal({})]} contacts={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: `Edit goals for ${monthLabel(LAST_MONTH)}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This month was not saved');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AdSpendDialog', () => {
  it('edits a month’s spend and writes the spend alone', async () => {
    const m = mutations();
    render(<AdSpendDialog open onOpenChange={() => {}} goals={[goal({ ad_spend: '120.00' })]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ad spend for ${monthLabel(LAST_MONTH)}` }));
    fireEvent.change(screen.getByLabelText(`Ad spend for ${monthLabel(LAST_MONTH)}`), { target: { value: '450' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.updateGoal.mutateAsync).toHaveBeenCalledWith({ id: 'g1', patch: { ad_spend: 450 } }));
  });

  it('refuses junk instead of saving it as zero', () => {
    const m = mutations();
    render(<AdSpendDialog open onOpenChange={() => {}} goals={[goal({ ad_spend: '120.00' })]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ad spend for ${monthLabel(LAST_MONTH)}` }));
    fireEvent.change(screen.getByLabelText(`Ad spend for ${monthLabel(LAST_MONTH)}`), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount');
    expect(m.updateGoal.mutateAsync).not.toHaveBeenCalled();
  });

  it('totals every month, reading amounts that arrive as strings', () => {
    render(
      <AdSpendDialog open onOpenChange={() => {}} goals={[goal({ ad_spend: '120.50' }), goal({ id: 'g2', month: THIS_MONTH, ad_spend: 79.5 })]} mutations={mutations()} />,
    );
    expect(screen.getByText('$200')).toBeInTheDocument();
  });

  it('a new month is written with its spend alone: no targets, which stay NULL', async () => {
    const m = mutations();
    render(<AdSpendDialog open onOpenChange={() => {}} goals={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Add month/ }));
    pickThisMonth('Month');
    fireEvent.change(screen.getByLabelText('Ad spend'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    await waitFor(() => expect(m.createGoal.mutateAsync).toHaveBeenCalled());
    expect(m.createGoal.mutateAsync).toHaveBeenCalledWith({ month: THIS_MONTH, ad_spend: 50 });
  });

  it('refuses a month already on the list, before writing', () => {
    const m = mutations();
    render(<AdSpendDialog open onOpenChange={() => {}} goals={[goal({ month: THIS_MONTH })]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Add month/ }));
    pickThisMonth('Month');
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    expect(screen.getByRole('alert')).toHaveTextContent('already on the list');
    expect(m.createGoal.mutateAsync).not.toHaveBeenCalled();
  });

  it('a new month needs a month picked first', () => {
    const m = mutations();
    render(<AdSpendDialog open onOpenChange={() => {}} goals={[]} mutations={m} />);
    fireEvent.click(screen.getByRole('button', { name: /Add month/ }));
    fireEvent.change(screen.getByLabelText('Ad spend'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a month.');
    expect(m.createGoal.mutateAsync).not.toHaveBeenCalled();
  });
});
