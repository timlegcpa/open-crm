import { StatusPill } from '@/components/ui/status-pill';
import { ENVELOPE_STATUS_LABELS, SIGNER_STATUS_LABELS } from '../contract';

/**
 * An envelope's or a signer's status as a pill. The status lives in the DOT: blue in
 * flight, amber waiting on someone, green done, red ended, grey not started. Statuses
 * nothing will happen to any more recede.
 */
const LABELS: Record<string, string> = { ...ENVELOPE_STATUS_LABELS, ...SIGNER_STATUS_LABELS };

const DOT: Record<string, string> = {
  draft: 'bg-muted-foreground/50',
  sent: 'bg-link',
  partially_signed: 'bg-warning',
  completed: 'bg-success',
  voided: 'bg-destructive',
  expired: 'bg-muted-foreground/50',
  declined: 'bg-destructive',
  pending: 'bg-muted-foreground/50',
  invited: 'bg-link',
  viewed: 'bg-warning',
  signed: 'bg-success',
};

const RETIRED = new Set(['expired', 'voided', 'declined']);

export function EsignStatusBadge({ status }: { status: string }) {
  return (
    <StatusPill dotClassName={DOT[status] ?? 'bg-muted-foreground/50'} muted={RETIRED.has(status)}>
      {LABELS[status] ?? status}
    </StatusPill>
  );
}
