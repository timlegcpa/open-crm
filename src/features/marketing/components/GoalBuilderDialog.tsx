import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Segmented } from '@/components/ui/segmented';
import { formatCurrencyShort, NO_VALUE_TEXT, todayISODate } from '@/lib/format';
import type { MonthlyGoal } from '../api';
import { planGoal, type GoalKind, type GoalResult, type MeasuredPace } from '../lib/goalPlanner';
import { totalMarketing, type MonthlyMarketingRow, type WonCohortFees } from '../lib/metrics';
import { addMonths, monthLabel, monthsBetween } from '../lib/months';
import { parseMoney, parseTarget, type GoalMutations } from './goalInputs';

const KIND_OPTIONS = [
  { value: 'recurring' as GoalKind, label: 'Recurring (ARR)' },
  { value: 'one_time' as GoalKind, label: 'One-time' },
];

/**
 * Months from `from` through `to`, oldest first. Uncapped on purpose: `planGoal` refuses a
 * deadline past its horizon, and the write button only exists for a plan it accepted, so the
 * months written are exactly the months planned.
 */
function planMonths(from: string, to: string): string[] {
  return Array.from({ length: monthsBetween(from, to) }, (_, i) => addMonths(from, i));
}

/**
 * The plan, refused when its monthly targets cannot be stored. Both target columns are
 * smallint, so a target goes through the same bounds as a typed one; a plan the database
 * would reject must never reach the confirm step.
 */
function storablePlan(result: GoalResult): GoalResult {
  if (!result.ok) return result;
  const { leads, won } = result.plan.monthlyTarget;
  for (const v of [won, leads]) {
    if (v == null) continue;
    const parsed = parseTarget(String(v));
    if (!parsed.ok) {
      return { ok: false, reason: `This plan needs ${v} a month, more than a monthly target can hold. Pick a later month or a smaller target.` };
    }
  }
  return result;
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className="text-[15px] font-semibold tabular-nums text-foreground">{value}</div>
    {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
  </div>
);

/**
 * Build a plan: back-solve a revenue target into monthly lead and win targets, from rates
 * measured over the page's range, and write them to each month through the deadline.
 */
export function GoalBuilderDialog({
  open,
  onOpenChange,
  monthRows,
  fees,
  rangeLabel,
  goals,
  mutations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rows the Monthly table shows, so the measured rates match the screen. */
  monthRows: MonthlyMarketingRow[];
  fees: WonCohortFees;
  rangeLabel: string;
  goals: MonthlyGoal[];
  mutations: GoalMutations;
}) {
  const thisMonth = todayISODate().slice(0, 7);
  const [kind, setKind] = useState<GoalKind>('recurring');
  const [targetText, setTargetText] = useState('');
  // Five months out, so the span this month through it is six months inclusive.
  const [targetMonth, setTargetMonth] = useState(() => addMonths(thisMonth, 5));
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rates come from the rows the table already shows, so the plan never quotes a close rate
  // that disagrees with the table's range total.
  //
  // Wins are counted for the selected kind only, the same wins `avgValue` is measured over:
  // nine one-time wins times the average of one recurring win is not a recurring pace. The
  // close rate follows the same count, so leads x rate still lands on the wins it plans for.
  const avgWins = kind === 'recurring' ? fees.recurringWins : fees.oneTimeWins;
  const pace: MeasuredPace = useMemo(() => {
    const t = totalMarketing(monthRows);
    const months = monthRows.length || 1;
    return {
      leadsPerMonth: t.leads / months,
      wonPerMonth: avgWins / months,
      convPct: t.leads > 0 ? Math.round((avgWins / t.leads) * 1000) / 10 : 0,
      avgValue: kind === 'recurring' ? fees.avgRecurringARR : fees.avgOneTime,
    };
  }, [monthRows, fees, kind, avgWins]);

  const months = monthsBetween(thisMonth, targetMonth);
  const target = parseMoney(targetText);
  const targetDollars = target.ok ? target.value : 0;
  const result: GoalResult =
    targetText.trim() !== '' && !target.ok ? { ok: false, reason: target.error } : storablePlan(planGoal({ targetDollars, months }, pace));

  const applyMonths = useMemo(() => (months > 0 ? planMonths(thisMonth, targetMonth) : []), [months, thisMonth, targetMonth]);
  const goalByMonth = useMemo(() => new Map(goals.map((g) => [g.month, g])), [goals]);
  const existingCount = applyMonths.filter((m) => goalByMonth.has(m)).length;

  const handleApply = async () => {
    if (!result.ok || applying) return;
    const { leads, won } = result.plan.monthlyTarget;
    setApplying(true);
    setError(null);
    // Settled, not `all`: a failure partway must not abandon the months behind it, and the
    // dialog has to know how many landed. A month that failed silently is worse than one
    // never written, because the table then shows a plan nobody set.
    const results = await Promise.allSettled(
      applyMonths.map((month) => {
        const existing = goalByMonth.get(month);
        if (existing) {
          // No ad_spend: this writes targets, never spend.
          return mutations.updateGoal.mutateAsync({
            id: existing.id,
            patch: {
              closed_clients_target: won,
              // A null lead target means the data could not size one: leave what is there.
              ...(leads != null ? { new_leads_target: leads } : {}),
            },
          });
        }
        // NULL, never 0, for a lead target the data could not size: a stored 0 makes the
        // table read "7 / 0", a blown goal rather than an unset one.
        return mutations.createGoal.mutateAsync({ month, closed_clients_target: won, new_leads_target: leads });
      }),
    );
    setApplying(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      // Stay open, so the owner sees the plan is half-written and can try again.
      setError(`${results.length - failed} of ${results.length} months saved. Try again to finish the rest.`);
      return;
    }
    setConfirming(false);
    onOpenChange(false);
  };

  const avgLabel = kind === 'recurring' ? 'Avg client (ARR)' : 'Avg one-time';
  const winsLabel = kind === 'recurring' ? 'Recurring wins / mo' : 'One-time wins / mo';
  const range = rangeLabel.toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setConfirming(false);
          setError(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl p-0">
        <ScrollArea fitWidth className="max-h-[90vh]">
          <div className="space-y-4 p-6">
            <DialogHeader>
              <DialogTitle>Build a plan</DialogTitle>
              <DialogDescription>
                Back-solves a revenue target into monthly lead and win targets, using only rates measured from your own data over {range}.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <span className="block text-[12px] font-medium">Goal</span>
                <Segmented label="Goal type" value={kind} onValueChange={setKind} options={KIND_OPTIONS} />
              </div>
              <div className="min-w-[140px] space-y-1">
                <Label className="text-[12px]" htmlFor="goal-target">Target</Label>
                <Input id="goal-target" inputMode="decimal" placeholder="50000" value={targetText} onChange={(e) => setTargetText(e.target.value)} className="h-9 tabular-nums" />
              </div>
              <div className="space-y-1">
                <Label className="text-[12px]" htmlFor="goal-by">By</Label>
                <DatePicker id="goal-by" monthOnly value={targetMonth} onChange={(v) => v && setTargetMonth(v)} />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                Measured over {range} ({monthRows.length} months)
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Leads / mo" value={pace.leadsPerMonth.toFixed(1)} />
                <Stat label={winsLabel} value={pace.wonPerMonth.toFixed(1)} />
                <Stat label="Close rate" value={pace.convPct > 0 ? `${pace.convPct}%` : NO_VALUE_TEXT} hint={kind === 'recurring' ? 'to a recurring win' : 'to a one-time win'} />
                <Stat label={avgLabel} value={pace.avgValue > 0 ? formatCurrencyShort(pace.avgValue) : NO_VALUE_TEXT} hint={avgWins > 0 ? `over ${avgWins} won` : undefined} />
              </div>
              {fees.withoutFees > 0 && (
                <p className="mt-2 text-[11px] text-warning-dark">
                  {fees.withoutFees} of {fees.wins} clients won in this range carry no accepted quote, so they are not in the average. Price them and
                  this plan gets sharper.
                </p>
              )}
              {/* States what the schema is, never what the data happens to be today. */}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Gross of clients leaving, which the app does not track. Ad spend is not an input: it is recorded as one figure a month with no
                channel on it, so there is no cost per lead to plan against.
              </p>
            </div>

            {!result.ok ? (
              <p className="text-[13px] text-muted-foreground">{result.reason}</p>
            ) : (
              <>
                <div className="rounded-lg border border-border p-3">
                  <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    To hit {formatCurrencyShort(targetDollars)} in {months} {months === 1 ? 'month' : 'months'}
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Stat label="Clients needed" value={String(result.plan.clientsNeeded)} />
                    <Stat label="Wins needed / mo" value={result.plan.requiredWonPerMonth.toFixed(1)} hint={`target ${result.plan.monthlyTarget.won}`} />
                    <Stat
                      label="Leads needed / mo"
                      value={result.plan.requiredLeadsPerMonth != null ? result.plan.requiredLeadsPerMonth.toFixed(1) : NO_VALUE_TEXT}
                      hint={result.plan.monthlyTarget.leads != null ? `target ${result.plan.monthlyTarget.leads}` : 'no close rate to divide by'}
                    />
                    <Stat
                      label="At current pace"
                      value={formatCurrencyShort(result.plan.projectedDollars)}
                      hint={result.plan.onPace ? 'on pace' : `${formatCurrencyShort(result.plan.shortfallDollars)} short`}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Three ways there, each holding the other two where they are</div>
                  <ul className="space-y-1.5 text-[13px] text-foreground">
                    <li>
                      <span className="text-muted-foreground">Leads:</span>{' '}
                      {result.plan.levers.leadsPerMonth != null ? (
                        <>run <strong className="tabular-nums">{result.plan.levers.leadsPerMonth}</strong> leads a month at today&apos;s {pace.convPct}% close rate</>
                      ) : (
                        <span className="text-muted-foreground">no measured close rate, so this cannot be answered from this range</span>
                      )}
                    </li>
                    <li>
                      <span className="text-muted-foreground">Close rate:</span>{' '}
                      {result.plan.levers.convPct != null ? (
                        <>close <strong className="tabular-nums">{result.plan.levers.convPct}%</strong> of today&apos;s {pace.leadsPerMonth.toFixed(1)} leads a month</>
                      ) : (
                        <span className="text-muted-foreground">no leads in this range to convert</span>
                      )}
                    </li>
                    <li>
                      <span className="text-muted-foreground">Client value:</span>{' '}
                      {result.plan.levers.avgValue != null ? (
                        <>average <strong className="tabular-nums">{formatCurrencyShort(result.plan.levers.avgValue)}</strong> a client at today&apos;s lead flow and close rate</>
                      ) : (
                        <span className="text-muted-foreground">no wins in this range to price</span>
                      )}
                    </li>
                  </ul>
                </div>

                {confirming ? (
                  <div className="rounded-lg border border-warning bg-warning-light/40 p-3">
                    <p className="text-[13px] text-foreground">
                      Write {result.plan.monthlyTarget.leads != null ? `${result.plan.monthlyTarget.leads} leads and ` : ''}
                      {result.plan.monthlyTarget.won} wins to each of {applyMonths.length} {applyMonths.length === 1 ? 'month' : 'months'},{' '}
                      {monthLabel(thisMonth)} through {monthLabel(targetMonth)}?
                      {existingCount > 0 &&
                        ` This overwrites the targets on ${existingCount} ${existingCount === 1 ? 'month that already has them' : 'months that already have them'}.`}{' '}
                      Ad spend is not touched.
                    </p>
                    {error && (
                      <p role="alert" className="mt-2 text-[13px] text-destructive">
                        {error}
                      </p>
                    )}
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" onClick={() => void handleApply()} disabled={applying}>
                        {applying ? 'Writing…' : 'Write the targets'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={applying}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => setConfirming(true)} disabled={applyMonths.length === 0}>
                      Apply to monthly targets
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
