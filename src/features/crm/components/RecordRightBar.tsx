import { Suspense } from 'react';
import { Link } from 'react-router-dom';
import type { Contact } from '@/api/contacts';
import { CopyValue } from '@/components/ui/copy-value';
import { contactSidePanels } from '@/features/registry';
import { links } from '@/features/links';
import { isTerminalStatus } from '@/lib/contactStatus';
import { formatCurrency, formatPhoneNumber } from '@/lib/format';
import { computeContactRevenue } from '@/lib/revenue';

export interface CopyItem {
  key: string;
  label: string;
  /** What is copied (and shown). */
  value: string;
}

/** The values the bar offers to copy, in the order they are reached for. Empty ones are left out. */
export function quickCopyItems(contact: Contact): CopyItem[] {
  const cityLine = [contact.mailing_city, [contact.mailing_state, contact.mailing_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [contact.mailing_street, cityLine].filter(Boolean).join(', ');
  const items: Array<CopyItem | null> = [
    contact.email ? { key: 'email', label: 'Email', value: contact.email } : null,
    contact.phone ? { key: 'phone', label: 'Phone', value: formatPhoneNumber(contact.phone) } : null,
    address ? { key: 'address', label: 'Mailing address', value: address } : null,
    contact.spouse_email ? { key: 'spouse_email', label: 'Spouse email', value: contact.spouse_email } : null,
    contact.spouse_phone ? { key: 'spouse_phone', label: 'Spouse phone', value: formatPhoneNumber(contact.spouse_phone) } : null,
    contact.business_name ? { key: 'business', label: 'Business', value: contact.business_name } : null,
  ];
  return items.filter((i): i is CopyItem => i !== null);
}

const HEAD = 'px-3.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground';

/**
 * The record's right bar: one panel, its sections divided by rules. Quick copy (the value
 * is the click target and copies itself; never a mail or dial link), then the panels other
 * features register (portal access, what is waiting), then the money, which links to
 * Billing and is hidden on a terminal status. Wide screens only, so nothing here is the
 * only way to reach anything.
 */
export function RecordRightBar({ contact }: { contact: Contact }) {
  const items = quickCopyItems(contact);
  const revenue = isTerminalStatus(contact.status) ? null : computeContactRevenue(contact);
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-[13px]">
      {items.length > 0 && (
        <section aria-label="Quick copy" className="pb-2">
          <h3 className={HEAD}>Quick copy</h3>
          <dl className="flex flex-col">
            {items.map((item) => (
              <div key={item.key} className="flex min-w-0 flex-col px-3.5 py-1">
                <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
                <dd className="min-w-0">
                  <CopyValue value={item.value} label={item.label.toLowerCase()} className="[overflow-wrap:anywhere]" />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {contactSidePanels.map(({ key, Component }) => (
        <Suspense key={key} fallback={null}>
          <Component contactId={contact.id} />
        </Suspense>
      ))}
      {revenue && (revenue.mrr > 0 || revenue.arr > 0) && (
        <section aria-label="Billing" className="pb-3">
          <h3 className={HEAD}>Billing</h3>
          <div className="grid grid-cols-2 gap-2 px-3.5">
            <div>
              <div className="text-[11px] text-muted-foreground">MRR</div>
              <div className="font-semibold tabular-nums">{formatCurrency(revenue.mrr, 0)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">ARR</div>
              <div className="font-semibold tabular-nums">{formatCurrency(revenue.arr, 0)}</div>
            </div>
          </div>
          <Link to={links.contactTab(contact.id, 'billing')} className="mt-2 block px-3.5 text-[12px] text-muted-foreground underline-offset-2 hover:underline">
            Open billing
          </Link>
        </section>
      )}
    </div>
  );
}
