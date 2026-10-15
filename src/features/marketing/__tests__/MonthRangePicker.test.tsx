import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MonthRangePicker } from '../components/MonthRangePicker';
import { addMonths } from '../lib/months';
import { MAX_RANGE_MONTHS } from '../lib/metrics';

// The calendar popover is the shared primitive's concern; here a plain box stands in for it
// so the test can type any month, however far back.
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ value, onChange, 'aria-label': label }: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const TO = '2026-08';

function renderPicker() {
  const onChange = vi.fn();
  render(<MonthRangePicker value={{ from: '2026-03', to: TO, preset: 'custom' }} onChange={onChange} />);
  const setFrom = (v: string) => fireEvent.change(screen.getByLabelText('First month'), { target: { value: v } });
  return { onChange, setFrom };
}

describe('MonthRangePicker', () => {
  it('takes a custom range up to the longest the page draws', () => {
    const { onChange, setFrom } = renderPicker();
    const from = addMonths(TO, -(MAX_RANGE_MONTHS - 1));
    setFrom(from);
    expect(onChange).toHaveBeenCalledWith({ from, to: TO, preset: 'custom' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // A longer range is refused out loud, never trimmed: the table would otherwise show fewer
  // months than the range says while the fees counted them all.
  it('refuses a longer range with a message and keeps the range it had', () => {
    const { onChange, setFrom } = renderPicker();
    setFrom(addMonths(TO, -MAX_RANGE_MONTHS));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(`at most ${MAX_RANGE_MONTHS} months`);
  });

  it('refuses a first month after the last', () => {
    const { onChange, setFrom } = renderPicker();
    setFrom('2026-09');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('first month comes after the last');
  });
});
