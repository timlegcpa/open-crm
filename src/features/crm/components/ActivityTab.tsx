import { Suspense } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { contactActivityCards } from '@/features/registry';
import type { ContactTabProps } from '@/features/types';
import { describeActivity, TONE_DOT_CLASS } from '@/lib/activityCatalog';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ACTIVITY_PAGE, flattenActivity, listActivity, type ActivityCursor } from '../api';
import { crmKeys } from '../keys';

/**
 * What the contact did in the portal and what was done to their account, newest first, 50
 * at a time; then the cards other features register for this tab (contactActivityCards).
 */
export function ActivityTab({ contactId }: ContactTabProps) {
  const activity = useInfiniteQuery({
    queryKey: crmKeys.activity(contactId),
    queryFn: ({ pageParam }) => listActivity(contactId, pageParam),
    initialPageParam: null as ActivityCursor | null,
    getNextPageParam: (last) => {
      const end = last[last.length - 1];
      return last.length < ACTIVITY_PAGE || !end ? undefined : { created_at: end.created_at, id: end.id };
    },
  });
  const rows = flattenActivity(activity.data?.pages ?? []);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Activity">
        <div className="px-3.5 py-3 text-[13px]">
          {activity.isPending && <p className="text-muted-foreground">Loading activity...</p>}
          {activity.isError && <p role="alert" className="text-destructive">Could not load activity: {getErrorMessage(activity.error)}</p>}
          {activity.isSuccess && rows.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
          {rows.length > 0 && (
            <ul className="flex flex-col">
              {rows.map((row) => {
                const { meta, detail } = describeActivity(row.action, row.details);
                return (
                  <li key={row.id} className="flex min-w-0 items-start gap-2.5 border-b border-border py-2 last:border-b-0">
                    <span aria-hidden="true" className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT_CLASS[meta.tone])} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{meta.label}</div>
                      {detail && <div className="truncate text-[12px] text-muted-foreground">{detail}</div>}
                    </div>
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{formatDateTime(row.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {activity.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
            >
              {activity.isFetchingNextPage ? 'Loading...' : 'Show older'}
            </Button>
          )}
        </div>
      </Panel>
      {contactActivityCards.map(({ key, Component }) => (
        <Suspense key={key} fallback={null}>
          <Component contactId={contactId} />
        </Suspense>
      ))}
    </div>
  );
}
