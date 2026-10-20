import { useQuery } from '@tanstack/react-query';
import { CountBadge } from '@/components/ui/count-badge';
import type { ContactTabProps, ShellCountProps } from '@/features/types';
import { documentKeys, getUnreviewedCount } from './api';

/**
 * The counts beside "Documents": client uploads (files and folders) the owner has not
 * reviewed. What is WAITING, never a total. Their own module so the rail does not
 * download the explorer to draw a number.
 */

function useUnreviewed(): number | undefined {
  return useQuery({
    queryKey: documentKeys.unreviewedCount(),
    queryFn: () => getUnreviewedCount(),
    staleTime: 60_000,
  }).data;
}

export function UnreviewedNavBadge() {
  return <CountBadge value={useUnreviewed()} title="Uploads to review" />;
}

/** The same figure in the shell's bottom bar (one query key, so one fetch). */
export function UnreviewedCount({ children }: ShellCountProps) {
  return <>{children(useUnreviewed())}</>;
}

export function UnreviewedContactBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({
    queryKey: documentKeys.unreviewedCount(contactId),
    queryFn: () => getUnreviewedCount(contactId),
    staleTime: 60_000,
  });
  return <CountBadge value={data} title="Uploads to review" />;
}
