import { Badge } from '@/components/ui/badge';
import type { ContactStatus } from '@/api/pickLists';

/** A status in its pick-list colour, or the raw key while the list is unknown. */
export function StatusBadge({ statusKey, status }: { statusKey: string; status: ContactStatus | undefined }) {
  const colour = status?.colour ?? null;
  return (
    <Badge
      variant="outline"
      style={colour ? { borderColor: colour, color: colour } : undefined}
      data-testid="status-badge"
    >
      {status?.label ?? statusKey}
    </Badge>
  );
}
