import type { Contact, ContactPatch, ContactService } from '@/api/contacts';
import { isTerminalStatus } from '@/lib/contactStatus';
import { parseMoneyAmount } from '@/lib/money';

/**
 * The mutation key every quote edit for one contact runs under. A stage move on the board
 * checks it and waits its turn: both write the contact's status, and a quote edit derives
 * its status nudge from the status it started with.
 */
export const quoteOpMutationKey = (contactId: string) => ['contact-quote-op', contactId] as const;

/**
 * THE status-change rule, for every path that changes a status (an explicit move, a bulk
 * change, a quote): the patch carries the status and nothing else. client_since is never
 * computed in the browser, because the browser only has a cached copy of the stored date
 * and an UPDATE filtered by id would overwrite a date it did not see. The database stamps
 * it in `contacts_record_status`, only when the STORED value is null; that date is the
 * database's current_date, which is UTC.
 */
export function statusChangePatch(next: string): ContactPatch {
  return { status: next };
}

const isRecurring = (r: Pick<ContactService, 'state' | 'cadence'>) =>
  r.state === 'accepted' && (r.cadence === 'monthly' || r.cadence === 'annual');
const isOneTime = (r: Pick<ContactService, 'state' | 'cadence'>) => r.state === 'accepted' && r.cadence === 'one_time';

/**
 * The contact patch a quote change implies, from the quotes AFTER the change and the
 * contact's status as just re-read (server truth, never the cache). An accepted monthly or annual quote makes the contact a client; accepted one-time
 * work alone makes it a one-time client. A terminal status (lost, cold, former client) is
 * sticky: a quote never promotes it. Null when nothing about the contact changes.
 */
export function contactPatchForQuoteChange(
  contact: Pick<Contact, 'status'>,
  nextRows: ReadonlyArray<Pick<ContactService, 'state' | 'cadence'>>,
): ContactPatch | null {
  if (isTerminalStatus(contact.status)) return null;
  const derived = nextRows.some(isRecurring) ? 'client' : nextRows.some(isOneTime) ? 'one_time' : null;
  if (!derived || derived === contact.status) return null;
  return statusChangePatch(derived);
}

/**
 * An inline money draft: blank is null (clear the value); a well-formed amount, zero
 * included, is its number (the shared strict rule, src/lib/money.ts); ANYTHING else is NaN,
 * so the caller aborts. Characters are never stripped to find a number inside a typo
 * ("oops0" must not become 0 and erase a price).
 */
export function parseCurrencyInput(draft: string): number | null {
  if (!draft.trim()) return null;
  return parseMoneyAmount(draft, { allowZero: true }) ?? Number.NaN;
}
