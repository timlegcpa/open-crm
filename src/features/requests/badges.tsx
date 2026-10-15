import { useQuery } from '@tanstack/react-query';
import { CountBadge } from '@/components/ui/count-badge';
import type { ContactTabProps } from '@/features/types';
import { countAwaitingAccept } from './api';
import { requestKeys } from './keys';

// A count only: answered items waiting on the owner's accept. Polled while the tab is in view.
const POLL = { staleTime: 60_000, refetchInterval: 30_000, refetchIntervalInBackground: false } as const;
const TITLE = 'Answered requests to accept';

/** Beside Requests in the sidebar. */
export function OwnerAwaitingBadge() {
  const { data } = useQuery({ queryKey: requestKeys.awaiting(), queryFn: () => countAwaitingAccept(), ...POLL });
  return <CountBadge value={data} title={TITLE} />;
}

/** On a contact's Requests tab. */
export function ContactAwaitingBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({ queryKey: requestKeys.awaiting(contactId), queryFn: () => countAwaitingAccept(contactId), ...POLL });
  return <CountBadge value={data} title={TITLE} />;
}
