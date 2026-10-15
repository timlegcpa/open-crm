import { useMemo, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/layout/page';
import { todayISODate } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import type { MonthlyGoal } from '../api';
import { leadsAndWonByMonth, type MarketingContact } from '../lib/metrics';
import { isMonthKey, monthLabel } from '../lib/months';
import { parseTarget, targetText, type GoalMutations } from './goalInputs';

function Measure({ label, actual, target }: { label: string; actual: number; target: number | null }) {
  const pct = target != null && target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[13px]">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {actual}
          {target != null && ` / ${target}`}
        </span>
      </div>
      {target == null ? (
        <p className="text-xs text-muted-foreground">No target</p>
      ) : (
        <>
          <Progress value={pct ?? 0} aria-label={`${label}: ${actual} of ${target}`} className="h-2" />
          <p className="mt-1 text-xs text-muted-foreground">
            {target === 0 ? 'Target of zero' : pct! >= 100 ? 'Goal met' : `${pct}% of the target`}
          </p>
        </>
      )}
    </div>
  );
}

interface Draft {
  id: string | null;
  month: string;
  leads: string;
  won: string;
}

/**
 * One card per goal month: leads and wins against its targets. The actuals come from
 * leadsAndWonByMonth, the same counts the Monthly table measures against the same targets.
 */
export function GoalsTab({ goals, contacts, mutations }: { goals: MonthlyGoal[]; contacts: readonly MarketingContact[]; mutations: GoalMutations }) {
  const thisMonth = todayISODate().slice(0, 7);
  const counts = useMemo(() => leadsAndWonByMonth(contacts), [contacts]);
  const goalByMonth = useMemo(() => new Map(goals.map((g) => [g.month, g])), [goals]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = (d: Draft) => {
    setError(null);
    setDraft(d);
  };

  const save = async () => {
    if (!draft) return;
    const leads = parseTarget(draft.leads);
    const won = parseTarget(draft.won);
    if (!leads.ok) return setError(leads.error);
    if (!won.ok) return setError(won.error);
    if (!draft.id) {
      if (!isMonthKey(draft.month)) return setError('Pick a month.');
      if (goalByMonth.has(draft.month)) return setError('That month already has goals. Edit it instead.');
    }
    setSaving(true);
    setError(null);
    try {
      const targets = { new_leads_target: leads.value, closed_clients_target: won.value };
      if (draft.id) await mutations.updateGoal.mutateAsync({ id: draft.id, patch: targets });
      else await mutations.createGoal.mutateAsync({ month: draft.month, ...targets });
      setDraft(null);
    } catch (err) {
      setError(getErrorMessage(err, 'The goal was not saved.'));
    } finally {
      setSaving(false);
    }
  };

  const newDraft = (): Draft => ({ id: null, month: goalByMonth.has(thisMonth) ? '' : thisMonth, leads: '', won: '' });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">New leads and new clients against each month&apos;s targets.</p>
        <Button size="sm" onClick={() => open(newDraft())}>
          <Plus /> Set a month&apos;s goals
        </Button>
      </div>

      {goals.length === 0 ? (
        <EmptyState title="No goals yet" description="Set targets for a month, or build a plan from a revenue target." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.map((g) => (
            <section
              key={g.id}
              aria-label={`Goals for ${monthLabel(g.month)}`}
              className={cn('space-y-3 rounded-lg border border-border bg-card p-4', g.month === thisMonth && 'border-foreground')}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {monthLabel(g.month)}
                  {g.month === thisMonth && <span className="ml-2 text-xs font-normal text-muted-foreground">This month</span>}
                </h3>
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Edit goals for ${monthLabel(g.month)}`}
                  onClick={() => open({ id: g.id, month: g.month, leads: targetText(g.new_leads_target), won: targetText(g.closed_clients_target) })}
                >
                  <Pencil /> Edit
                </Button>
              </div>
              <Measure label="New leads" actual={counts.leadsByMonth.get(g.month) ?? 0} target={g.new_leads_target} />
              <Measure label="New clients" actual={counts.wonByMonth.get(g.month) ?? 0} target={g.closed_clients_target} />
            </section>
          ))}
        </div>
      )}

      <Dialog open={draft != null} onOpenChange={(o) => !o && !saving && setDraft(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{draft?.id ? `Goals for ${monthLabel(draft.month)}` : 'Set a month’s goals'}</DialogTitle>
            <DialogDescription>Leave a box empty for no target. Zero is a target of zero.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              {!draft.id && (
                <div className="space-y-1">
                  <Label htmlFor="goal-month">Month</Label>
                  <DatePicker id="goal-month" monthOnly value={draft.month} onChange={(v) => setDraft({ ...draft, month: v })} placeholder="Pick a month" className="w-full" />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="goal-leads">New leads target</Label>
                <Input id="goal-leads" inputMode="numeric" value={draft.leads} onChange={(e) => setDraft({ ...draft, leads: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="goal-won">New clients target</Label>
                <Input id="goal-won" inputMode="numeric" value={draft.won} onChange={(e) => setDraft({ ...draft, won: e.target.value })} />
              </div>
              {error && (
                <p role="alert" className="text-[13px] text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setDraft(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
