import type { CSSProperties } from 'react';
import type { ContactStatus } from '@/api/pickLists';
import { Monogram } from '@/components/ui/monogram';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';

/**
 * Status colour has ONE source: `contact_statuses.colour` (seeded per stage in 0002, the
 * owner's to change). It is drawn only as a dot or a faint tint, never as text colour, so a
 * pale colour the owner picks can never make a label unreadable. A status with no colour
 * draws the neutral dot.
 */
const HEX = /^#[0-9a-f]{6}$/;

export function statusDotStyle(status: ContactStatus | undefined): CSSProperties | undefined {
  const colour = status?.colour;
  return colour && HEX.test(colour) ? { backgroundColor: colour } : undefined;
}

/** A faint wash of the status colour, for a monogram disc. */
export function statusTintStyle(status: ContactStatus | undefined): CSSProperties | undefined {
  const colour = status?.colour;
  return colour && HEX.test(colour) ? { backgroundColor: `${colour}26`, boxShadow: `inset 0 0 0 1px ${colour}4d` } : undefined;
}

/** A status as a quiet capsule: the dot carries the colour, the label stays foreground. */
export function StatusBadge({ statusKey, status, className }: { statusKey: string; status: ContactStatus | undefined; className?: string }) {
  return (
    <StatusPill dotClassName="bg-muted-foreground" dotStyle={statusDotStyle(status)} className={className}>
      {status?.label ?? statusKey}
    </StatusPill>
  );
}

/** A contact's initials disc, washed with its status colour. Decorative: the name sits beside it. */
export function StatusMonogram({
  initials,
  status,
  size = 'sm',
  className,
}: {
  initials: string;
  status: ContactStatus | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const tint = statusTintStyle(status);
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 rounded-full bg-secondary', className)} style={tint}>
      <Monogram initials={initials} size={size} className={tint ? 'bg-transparent ring-0' : undefined} />
    </span>
  );
}
