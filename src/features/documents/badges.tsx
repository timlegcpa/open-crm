import { useQuery } from '@tanstack/react-query';
import { CountBadge } from '@/components/ui/count-badge';
import type { ContactTabProps } from '@/features/types';
import { documentKeys, getUnreviewedCount } from './api';

/**
 * The counts beside "Documents": client uploads (files and folders) the owner has not
 * reviewed. What is WAITING, never a total. Their own module so the sidebar does not
 * download the explorer to draw a number.
 */

export function UnreviewedNavBadge() {
  const { data } = useQuery({
    queryKey: documentKeys.unreviewedCount(),
    queryFn: () => getUnreviewedCount(),
    staleTime: 60_000,
  });
  return <CountBadge value={data} title="Uploads to review" />;
}

export function UnreviewedContactBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({
    queryKey: documentKeys.unreviewedCount(contactId),
    queryFn: () => getUnreviewedCount(contactId),
    staleTime: 60_000,
  });
  return <CountBadge value={data} title="Uploads to review" />;
}
