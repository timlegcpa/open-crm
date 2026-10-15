import type { RecipientStatus } from './api';

export type StatusDotTone = 'success' | 'error' | 'warning' | 'muted';

/**
 * A recipient's delivery state in the owner's words. `unknown` is the one that earns its
 * place: delivery could not be established (the run was interrupted, or the provider never
 * answered). It is not a failure and must never look like one, since nobody should send
 * again to this address on the strength of it: a failed send reached nobody, an
 * unconfirmed one may have.
 */
export const RECIPIENT_STATUS: Record<RecipientStatus, { label: string; tone: StatusDotTone }> = {
  sent: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'muted' },
  unknown: { label: 'Unconfirmed', tone: 'warning' },
  queued: { label: 'Queued', tone: 'muted' },
  sending: { label: 'Sending', tone: 'muted' },
};

/** The theme's dot colour for each tone (StatusPill's dotClassName). */
export const TONE_DOT: Record<StatusDotTone, string> = {
  success: 'bg-success',
  error: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};

export function recipientStatus(status: string): { label: string; dot: string } {
  const meta = (RECIPIENT_STATUS as Record<string, { label: string; tone: StatusDotTone } | undefined>)[status];
  return meta ? { label: meta.label, dot: TONE_DOT[meta.tone] } : { label: status, dot: TONE_DOT.muted };
}
