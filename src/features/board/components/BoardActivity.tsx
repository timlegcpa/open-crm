import { useMemo } from 'react';
import { History } from 'lucide-react';
import { EmptyState } from '@/components/layout/page';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { getErrorMessage } from '@/lib/errors';
import { formatDate, formatTime, toISODate } from '@/lib/format';
import { boardActivity, type ActivityEntry } from '../board';
import { useBoardHistory, useBoardStages } from '../hooks';
import { StageBadge } from './StageBadge';
import type { BoardStage } from '../api';

/**
 * The Activity tab: every creation, move and note across the board, newest first, grouped by the
 * viewer's day, the latest 150. It only reads, through the board's one history query.
 * `descriptions` names each row; a card it cannot name (deleted, or archived) says so
 * rather than showing an id.
 */
export function BoardActivity({ descriptions }: { descriptions: ReadonlyMap<string, string> }) {
  const history = useBoardHistory();
  const { rows } = useBoardStages();
  const entries = useMemo(() => boardActivity(history.data ?? [], descriptions), [history.data, descriptions]);

  if (history.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading activity">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (history.isError) {
    return <EmptyState icon={<History />} title="Could not load the activity" description={getErrorMessage(history.error, 'Please try again.')} />;
  }
  if (entries.length === 0) return <EmptyState icon={<History />} title="No activity yet" />;

  const days: { day: string; rows: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const day = toISODate(new Date(entry.at));
    const last = days[days.length - 1];
    if (last && last.day === day) last.rows.push(entry);
    else days.push({ day, rows: [entry] });
  }

  return (
    <ScrollArea fitWidth className="min-h-0 flex-1">
      <div className="flex flex-col gap-5 pb-2">
        {days.map(({ day, rows: dayRows }) => (
          <section key={day} className="flex flex-col gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{formatDate(day)}</h3>
            <ol className="flex flex-col divide-y divide-border/60 rounded-lg border border-border bg-card">
              {dayRows.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} stages={rows} />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

function ActivityRow({ entry, stages }: { entry: ActivityEntry; stages: ReadonlyMap<string, BoardStage> }) {
  return (
    <li className="flex gap-3 px-3 py-2.5">
      <span className="w-16 shrink-0 pt-0.5 text-[12px] tabular-nums text-muted-foreground">{formatTime(entry.at)}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="font-medium text-foreground [overflow-wrap:anywhere]">{entry.subject}</span>
          {entry.kind === 'created' ? (
            <>
              <span className="text-[12px] text-muted-foreground">added to</span>
              <StageBadge stageKey={entry.toValue} rows={stages} />
            </>
          ) : entry.kind === 'move' ? (
            <>
              <StageBadge stageKey={entry.fromValue} rows={stages} />
              <span aria-hidden="true" className="text-muted-foreground">
                {'→'}
              </span>
              <span className="sr-only">to</span>
              <StageBadge stageKey={entry.toValue} rows={stages} />
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground">note</span>
          )}
        </div>
        {entry.note && <p className="w-fit max-w-full rounded-md bg-muted/60 px-2 py-1 text-[12px] text-foreground [overflow-wrap:anywhere]">{entry.note}</p>}
      </div>
    </li>
  );
}
