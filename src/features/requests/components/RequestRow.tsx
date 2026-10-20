import { Link } from 'react-router-dom';
import { ToneBadge, type ToneBadgeVariant } from '@/components/ui/tone-badge';
import { links } from '@/features/links';
import { formatDate } from '@/lib/format';
import { LIST_STATUS_LABELS, listProgress, type ListStatus, type RequestWithItems } from '../lib/requests';

// Its own module: the request lists on other screens (Documents) draw these rows without
// loading the builder or the detail.

export const LIST_TONES: Record<ListStatus, ToneBadgeVariant> = {
  draft: 'default',
  sent: 'attention',
  submitted: 'review',
  closed: 'neutral',
};

/** One request in a list: its title, who it is for, its status and progress. Opens the request. */
export function RequestRow({ request, contactName }: { request: RequestWithItems; contactName: string | null }) {
  const progress = listProgress(request.items);
  const when = request.sent_at ? `Sent ${formatDate(request.sent_at)}` : `Created ${formatDate(request.created_at)}`;
  return (
    <Link to={links.request(request.id)} className="flex flex-col gap-1 px-4 py-2.5 hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">{request.title}</p>
        <p className="truncate text-[12px] text-muted-foreground">{[contactName, when].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        {request.status !== 'draft' && <span className="tabular-nums">{`${progress.fulfilled} of ${progress.actionable} answered`}</span>}
        {progress.awaitingAccept > 0 && (request.status === 'sent' || request.status === 'submitted') && (
          <ToneBadge variant="warning">{`${progress.awaitingAccept} to accept`}</ToneBadge>
        )}
        <ToneBadge variant={LIST_TONES[request.status]}>{LIST_STATUS_LABELS[request.status]}</ToneBadge>
      </div>
    </Link>
  );
}
