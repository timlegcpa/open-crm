import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/format';
import type { BoardStage } from '../api';
import { NO_NOTE_RECORDED, type BoardHistoryEvent } from '../board';
import { stageTone } from '../stageTone';
import { StageBadge } from './StageBadge';

const NOTE_SURFACE = 'mt-1 rounded-md bg-muted/60 px-2 py-1 text-[12px] text-foreground [overflow-wrap:anywhere]';

/**
 * A card's history as a timeline, newest first. A move shows where it came from and where
 * it went, its time, and its reason on a surface of its own (the one authored sentence on
 * the row). The rail takes the colour of the lane the card moved INTO: that end is where
 * the work is now. A note row has no ends, so it draws no badges and no coloured rail. The
 * creation row names the lane the card started in, and its starting note when it had one.
 */
export function BoardHistoryList({
  events,
  rows,
  compact = false,
}: {
  events: readonly BoardHistoryEvent[];
  rows: ReadonlyMap<string, BoardStage>;
  /** The hover preview: the latest four and a count of the rest. */
  compact?: boolean;
}) {
  const shown = compact ? events.slice(0, 4) : events;
  return (
    <ol className="space-y-2">
      {shown.map((event) => {
        if (event.kind === 'note') {
          return (
            <li key={event.id} className="border-l-2 border-border pl-2.5">
              <div className="text-[12px] tabular-nums text-muted-foreground">{formatDateTime(event.at)}</div>
              <p className={NOTE_SURFACE}>{event.note}</p>
            </li>
          );
        }
        const rail = stageTone(event.toValue, event.toValue ? rows.get(event.toValue)?.colour : null).dot;
        if (event.kind === 'created') {
          return (
            <li key={event.id} className="border-l-2 pl-2.5" style={{ borderColor: rail }}>
              <div className="flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground">
                Added to
                <StageBadge stageKey={event.toValue} rows={rows} />
              </div>
              <div className="mt-1 text-[12px] tabular-nums text-muted-foreground">{formatDateTime(event.at)}</div>
              {event.note && <p className={NOTE_SURFACE}>{event.note}</p>}
            </li>
          );
        }
        return (
          <li key={event.id} className="border-l-2 pl-2.5" style={{ borderColor: rail }}>
            <div className="flex flex-wrap items-center gap-1">
              <StageBadge stageKey={event.fromValue} rows={rows} />
              <span aria-hidden="true" className="text-muted-foreground">
                {'→'}
              </span>
              <span className="sr-only">to</span>
              <StageBadge stageKey={event.toValue} rows={rows} />
            </div>
            <div className="mt-1 text-[12px] tabular-nums text-muted-foreground">{formatDateTime(event.at)}</div>
            <p className={event.note ? NOTE_SURFACE : 'mt-1 text-[12px] italic text-muted-foreground'}>{event.note ?? NO_NOTE_RECORDED}</p>
          </li>
        );
      })}
      {compact && events.length > shown.length && (
        <li className="pl-2.5 text-[12px] text-muted-foreground">{events.length - shown.length} more</li>
      )}
    </ol>
  );
}

/**
 * A card's history in the history dialog, honest about the read behind it: a skeleton
 * while it loads, the failure with a retry when it failed, and "nothing yet" only when the
 * read succeeded and found nothing. A failed read shown as an empty history says nothing
 * ever happened to the card.
 */
export function BoardHistoryPanel({
  status,
  events,
  rows,
  onRetry,
}: {
  status: 'pending' | 'error' | 'success';
  events: readonly BoardHistoryEvent[];
  rows: ReadonlyMap<string, BoardStage>;
  onRetry: () => void;
}) {
  if (status === 'pending') {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading history">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" role="alert">
        Could not load this card's history.
        <Button type="button" size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (events.length === 0) return <p className="text-[13px] text-muted-foreground">No notes or moves yet.</p>;
  return (
    <div className="pr-3">
      <BoardHistoryList events={events} rows={rows} />
    </div>
  );
}
