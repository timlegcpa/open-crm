import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ContactTabProps } from '@/features/types';
import { Panel } from '@/components/layout/page';
import { StatusPill } from '@/components/ui/status-pill';
import { formatDateTime, NO_VALUE_TEXT } from '@/lib/format';
import { emailKeys, listRecipientsForContact } from './api';
import { recipientStatus } from './status';

/**
 * The group emails one contact was sent, for the contact's Activity. Group email is its
 * own send log, not part of the portal activity feed, so it is its own card. Nothing to
 * show: nothing rendered.
 */
export function GroupEmailHistory({ contactId }: ContactTabProps) {
  const rows = useQuery({ queryKey: emailKeys.forContact(contactId), queryFn: () => listRecipientsForContact(contactId) });

  if (rows.isError) {
    return (
      <Panel title="Group email">
        <p role="alert" className="px-3.5 py-3 text-[13px] text-destructive">Could not load group emails.</p>
      </Panel>
    );
  }
  if (!rows.data || rows.data.length === 0) return null;

  return (
    <Panel title="Group email">
      <ul className="divide-y divide-border">
        {rows.data.map((r) => {
          const s = recipientStatus(r.status);
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-[13px]">
              <StatusPill dotClassName={s.dot}>{s.label}</StatusPill>
              {r.campaign ? (
                <Link to={`/email/${encodeURIComponent(r.campaign.id)}`} className="min-w-0 flex-1 truncate hover:underline">
                  {r.campaign.subject}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate">{NO_VALUE_TEXT}</span>
              )}
              <span className="hidden truncate text-muted-foreground md:inline">{r.address}</span>
              <span className="shrink-0 text-muted-foreground">{formatDateTime(r.sent_at ?? r.created_at)}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
