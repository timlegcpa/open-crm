import { useQuery } from '@tanstack/react-query';
import { CountBadge } from '@/components/ui/count-badge';
import type { ContactTabProps, ShellCountProps } from '@/features/types';
import { countUnread } from './api';
import { messagesKeys } from './keys';

// A count only, no content: shown whether or not messages are unlocked. Polled while the
// tab is in view; a conversation or the inbox refreshes it at once when it marks reads.
const POLL = { staleTime: 60_000, refetchInterval: 30_000, refetchIntervalInBackground: false } as const;

function useOwnerUnread(): number | undefined {
  return useQuery({ queryKey: messagesKeys.unread(), queryFn: () => countUnread(), ...POLL }).data;
}

/** On the workspace's Messages tab: clients' messages waiting to be read. */
export function OwnerUnreadBadge() {
  return <CountBadge value={useOwnerUnread()} title="Unread messages" />;
}

/** The same figure in the shell's bottom bar (one query key, so one fetch). */
export function OwnerUnreadCount({ children }: ShellCountProps) {
  return <>{children(useOwnerUnread())}</>;
}

/** On a contact's Messages tab: that contact's messages waiting to be read. */
export function ContactUnreadBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({ queryKey: messagesKeys.unreadFor(contactId), queryFn: () => countUnread(contactId), ...POLL });
  return <CountBadge value={data} title="Unread messages" />;
}
