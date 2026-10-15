import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { toISODate } from '@/lib/format';
import { addMonths, isMonthKey, monthsBetween } from '../lib/months';
import { MAX_RANGE_MONTHS } from '../lib/metrics';

/**
 * Every range is [from, to] inclusive at MONTH grain ('YYYY-MM'): every table on the page
 * groups by month. Months are the viewer's LOCAL calendar months, never UTC: a UTC month is
 * next month for the first hours of the 1st west of Greenwich, and a UTC year turns
 * "year to date" into next January through this December on New Year's Eve.
 */
export type RangePreset = 'this_month' | 'ytd' | 'all' | 'custom';

export interface MonthRange {
  from: string;
  to: string;
  preset: RangePreset;
}

export const RANGE_LABEL: Record<RangePreset, string> = {
  this_month: 'This month',
  ytd: 'Year to date',
  all: 'All time',
  custom: 'Custom months',
};

export function rangeFromPreset(preset: RangePreset, today = new Date()): MonthRange {
  const thisMonth = toISODate(today).slice(0, 7);
  switch (preset) {
    case 'this_month':
      return { from: thisMonth, to: thisMonth, preset };
    case 'ytd':
      return { from: `${today.getFullYear()}-01`, to: thisMonth, preset };
    case 'all':
      return { from: addMonths(thisMonth, -(MAX_RANGE_MONTHS - 1)), to: thisMonth, preset };
    case 'custom':
      return { from: addMonths(thisMonth, -5), to: thisMonth, preset };
  }
}

export function MonthRangePicker({ value, onChange }: { value: MonthRange; onChange: (next: MonthRange) => void }) {
  const [draftFrom, setDraftFrom] = useState(value.from);
  const [draftTo, setDraftTo] = useState(value.to);
  const [rangeError, setRangeError] = useState<string | null>(null);
  useEffect(() => {
    setDraftFrom(value.from);
    setDraftTo(value.to);
  }, [value.from, value.to]);

  // Takes both bounds rather than reading the drafts: it runs in the same tick as the
  // draft setters, where state still holds the previous value.
  // A range longer than the page can draw is refused out loud, never trimmed: a trimmed
  // range would show fewer months than it says.
  const commitCustom = (from: string, to: string) => {
    if (!isMonthKey(from) || !isMonthKey(to)) return;
    if (from > to) {
      setRangeError('The first month comes after the last.');
      return;
    }
    if (monthsBetween(from, to) > MAX_RANGE_MONTHS) {
      setRangeError(`Pick a range of at most ${MAX_RANGE_MONTHS} months.`);
      return;
    }
    setRangeError(null);
    onChange({ from, to, preset: 'custom' });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.preset}
        onValueChange={(v) => {
          const preset = v as RangePreset;
          setRangeError(null);
          onChange(preset === 'custom' ? { from: draftFrom, to: draftTo, preset } : rangeFromPreset(preset));
        }}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(RANGE_LABEL) as RangePreset[]).map((p) => (
            <SelectItem key={p} value={p}>
              {RANGE_LABEL[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.preset === 'custom' && (
        <>
          <DatePicker
            monthOnly
            value={draftFrom}
            onChange={(v) => {
              setDraftFrom(v);
              commitCustom(v, draftTo);
            }}
            placeholder="From"
            aria-label="First month"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <DatePicker
            monthOnly
            value={draftTo}
            onChange={(v) => {
              setDraftTo(v);
              commitCustom(draftFrom, v);
            }}
            placeholder="To"
            aria-label="Last month"
            className="h-8 text-xs"
          />
          {rangeError && (
            <p role="alert" className="w-full text-xs text-destructive">
              {rangeError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
