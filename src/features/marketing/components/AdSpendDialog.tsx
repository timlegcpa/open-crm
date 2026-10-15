import { useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatCurrencyShort, todayISODate } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { num } from '@/lib/revenue';
import type { MonthlyGoal } from '../api';
import { isMonthKey, monthLabel } from '../lib/months';
import { parseAmount, type GoalMutations } from './goalInputs';

/**
 * Each month's ad spend. A new month is written with its spend ONLY: its targets stay NULL
 * ("no target"), never 0, which the Monthly table would read as a target of zero.
 */
export function AdSpendDialog({
  open,
  onOpenChange,
  goals,
  mutations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goals: MonthlyGoal[];
  mutations: GoalMutations;
}) {
  const thisMonth = todayISODate().slice(0, 7);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [newMonth, setNewMonth] = useState('');
  const [newSpend, setNewSpend] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const existing = new Set(goals.map((g) => g.month));
  const total = goals.reduce((s, g) => s + num(g.ad_spend), 0);

  const run = async (write: () => Promise<unknown>, done: () => void) => {
    setSaving(true);
    setError(null);
    try {
      await write();
      done();
    } catch (err) {
      setError(getErrorMessage(err, 'The spend was not saved.'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = (goal: MonthlyGoal) => {
    const amount = parseAmount(editValue);
    if (!amount.ok) return setError(amount.error);
    void run(() => mutations.updateGoal.mutateAsync({ id: goal.id, patch: { ad_spend: amount.value } }), () => setEditingId(null));
  };

  const addMonth = () => {
    if (!isMonthKey(newMonth)) return setError('Pick a month.');
    if (newMonth > thisMonth) return setError('Spend is entered for this month or an earlier one.');
    if (existing.has(newMonth)) return setError('That month is already on the list. Edit it below.');
    const amount = parseAmount(newSpend);
    if (!amount.ok) return setError(amount.error);
    void run(
      () => mutations.createGoal.mutateAsync({ month: newMonth, ad_spend: amount.value }),
      () => {
        setAdding(false);
        setNewMonth('');
        setNewSpend('');
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          setEditingId(null);
          setAdding(false);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Monthly ad spend</DialogTitle>
          <DialogDescription>One amount per month, across every channel.</DialogDescription>
        </DialogHeader>

        {adding ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor="spend-month">Month</Label>
              <DatePicker
                id="spend-month"
                monthOnly
                value={newMonth}
                onChange={setNewMonth}
                placeholder="Pick a month"
                className="w-full"
                calendar={{ disabled: { after: new Date() } }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="spend-amount">Ad spend</Label>
              <Input id="spend-amount" inputMode="decimal" placeholder="0" value={newSpend} onChange={(e) => setNewSpend(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addMonth} disabled={saving}>
                Add month
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAdding(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="w-full border-dashed" onClick={() => setAdding(true)}>
            <Plus /> Add month
          </Button>
        )}

        {error && (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        )}

        {goals.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted-foreground">No months yet.</p>
        ) : (
          <>
            <ScrollArea fitWidth className="max-h-80">
              <ul className="space-y-1.5 pr-2">
                {goals.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                    <span className="text-[13px] font-medium text-foreground">{monthLabel(g.month)}</span>
                    {editingId === g.id ? (
                      <span className="flex items-center gap-1">
                        <Input
                          aria-label={`Ad spend for ${monthLabel(g.month)}`}
                          inputMode="decimal"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && saveEdit(g)}
                          className="h-8 w-28"
                          autoFocus
                        />
                        <Button size="icon-sm" variant="ghost" aria-label="Save" onClick={() => saveEdit(g)} disabled={saving}>
                          <Check />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditingId(null)} disabled={saving}>
                          <X />
                        </Button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold tabular-nums text-foreground">{formatCurrencyShort(num(g.ad_spend))}</span>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Edit ad spend for ${monthLabel(g.month)}`}
                          onClick={() => {
                            setError(null);
                            setEditingId(g.id);
                            setEditValue(num(g.ad_spend) ? String(num(g.ad_spend)) : '');
                          }}
                        >
                          <Pencil />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
            {total > 0 && (
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-[13px] text-muted-foreground">All months</span>
                <span className="font-semibold tabular-nums text-foreground">{formatCurrencyShort(total)}</span>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
