import { useQuery } from '@tanstack/react-query';
import { CountBadge } from '@/components/ui/count-badge';
import type { ContactTabProps, ShellCountProps } from '@/features/types';
import { countAwaitingAccept } from './api';
import { requestKeys } from './keys';

// A count only: answered items waiting on the owner's accept. Polled while the tab is in view.
const POLL = { staleTime: 60_000, refetchInterval: 30_000, refetchIntervalInBackground: false } as const;
const TITLE = 'Answered requests to accept';

function useOwnerAwaiting(): number | undefined {
  return useQuery({ queryKey: requestKeys.awaiting(), queryFn: () => countAwaitingAccept(), ...POLL }).data;
}

/** On the workspace's Requests tab. */
export function OwnerAwaitingBadge() {
  return <CountBadge value={useOwnerAwaiting()} title={TITLE} />;
}

/** The same figure in the shell's bottom bar (one query key, so one fetch). */
export function OwnerAwaitingCount({ children }: ShellCountProps) {
  return <>{children(useOwnerAwaiting())}</>;
}

/** On a contact's Requests tab. */
export function ContactAwaitingBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({ queryKey: requestKeys.awaiting(contactId), queryFn: () => countAwaitingAccept(contactId), ...POLL });
  return <CountBadge value={data} title={TITLE} />;
}
