import type { Delivery, GroupEmailSendResult } from './api';

/**
 * The one place a crm-send-group-email answer becomes words. A repeated request id returns
 * the earlier campaign's report (`duplicate`, with `unknown`, `unsent` and `still_running`),
 * and reading that as a fresh "Sent" is how a still-running or interrupted send goes
 * unnoticed.
 */
export interface SendResultDescription {
  title: string;
  description: string;
  /** True for the one outcome that must be acted on: some recipients may not have it. */
  incomplete: boolean;
}

export function describeSendResult(result: GroupEmailSendResult): SendResultDescription {
  const verb = result.delivery === 'dev_outbox' ? 'written to the dev outbox' : 'delivered';
  const parts = [`${result.sent} ${verb}`];
  if (result.failed) parts.push(`${result.failed} failed`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  if (result.unknown) parts.push(`${result.unknown} unconfirmed`);
  // The same count, two facts: while a run can still be going those recipients are in
  // flight; once nothing can be working the list they were never sent.
  const stillRunning = Boolean(result.still_running);
  if (result.unsent) parts.push(stillRunning ? `${result.unsent} still sending` : `${result.unsent} never sent`);
  const counts = `${parts.join(', ')}.`;
  const incomplete = Boolean(result.unknown || (result.unsent && !stillRunning));
  const outbox = result.delivery === 'dev_outbox' ? ' No email provider is configured, so nothing left this server.' : '';
  return {
    title: incomplete ? 'Sent, but not to everyone' : result.duplicate ? 'Already sent' : 'Sent',
    // `duplicate`: this exact composition was already accepted, so nothing new went out on
    // this click. It does not mean everyone received it, which is why the counts follow.
    description: (result.duplicate ? `Nothing new went out. This email was already submitted. ${counts}` : counts) + outbox,
    incomplete,
  };
}

/** What the page says about where messages will go, before a send. */
export function deliveryNote(d: Delivery): string | null {
  return d === 'dev_outbox'
    ? 'No email provider is configured. Messages are written to the dev outbox and nobody receives them.'
    : null;
}
