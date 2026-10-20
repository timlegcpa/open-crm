import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useIsMutating } from '@tanstack/react-query';
import type { Contact } from '@/api/contacts';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';
import { CopyValue } from '@/components/ui/copy-value';
import { useContactStatuses, useLeadSources } from '@/hooks/usePickLists';
import { contactSidePanels } from '@/features/registry';
import { links } from '@/features/links';
import { isSystemStatus, isTerminalStatus } from '@/lib/contactStatus';
import { formatPhoneNumber } from '@/lib/format';
import { contactFieldMutationKey, useContactFieldSave } from '../hooks';
import { quoteOpMutationKey } from '../lib/quotes';
import { TIER_OPTIONS, tierValue, UNRANKED } from '../lib/tiers';
import { EditableField } from './EditableField';
import { STATIC_VALUE } from './FieldRow';

// Loaded only when the bar shows it, so the record shell never carries the editor.
const CompactQuoteEditor = lazy(() => import('./quotes/CompactQuoteEditor').then((m) => ({ default: m.CompactQuoteEditor })));

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
const FIELD_LABEL = 'text-[11px] text-muted-foreground';

/**
 * The record's right bar: one panel, its sections divided by rules. Quick edit first
 * (status, tier, email, phone, source, saved in place, as the board's card bar does), then
 * quick copy for the rest (the value is the click target and copies itself; never a mail or
 * dial link), then the panels other features register (portal access, what is waiting),
 * then the services editor, left off the tabs whose body already holds it (Overview,
 * Billing) and hidden on a terminal status. Wide screens only, so nothing here is the only
 * way to reach anything.
 *
 * The status and the quotes each wait for the other, as on Overview: a quote save
 * re-derives the status from the one it read.
 */
export function RecordRightBar({ contact, showServices = true }: { contact: Contact; showServices?: boolean }) {
  const save = useContactFieldSave(contact);
  const statuses = useContactStatuses();
  const sources = useLeadSources();
  const quoteSaving = useIsMutating({ mutationKey: quoteOpMutationKey(contact.id) }) > 0;
  const fieldSaving = useIsMutating({ mutationKey: contactFieldMutationKey(contact.id) }) > 0;
  // Email and phone are edited above, so the copy list keeps the rest.
  const items = quickCopyItems(contact).filter((i) => i.key !== 'email' && i.key !== 'phone');
  const statusOptions = (statuses.data ?? []).filter((s) => !isSystemStatus(s.key)).map((s) => ({ value: s.key, label: s.label }));
  const sourceOptions = (sources.data ?? [])
    .filter((s) => s.is_active || s.key === contact.source)
    .map((s) => ({ value: s.key, label: s.label }));
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-[13px]">
      <section aria-label="Quick edit" className="pb-2.5">
        <h3 className={HEAD}>Quick edit</h3>
        <div className="flex flex-col gap-2 px-3.5">
          <div>
            <div className={FIELD_LABEL}>Status</div>
            {isSystemStatus(contact.status) ? (
              // A system status (signer only) is shown, never offered.
              <span className={STATIC_VALUE}>{statuses.data?.find((s) => s.key === contact.status)?.label ?? contact.status}</span>
            ) : (
              <EditableField type="select" label="Status" value={contact.status} options={statusOptions} disabled={quoteSaving} onSave={save('status')} />
            )}
          </div>
          <div>
            <div className={FIELD_LABEL}>Tier</div>
            <EditableField type="select" label="Tier" value={contact.tier ?? UNRANKED} options={TIER_OPTIONS} onSave={(v) => save('tier')(tierValue(v))} />
          </div>
          <div>
            <div className={FIELD_LABEL}>Email</div>
            <ContactEmailsManager contactId={contact.id} kind="primary" />
          </div>
          <div>
            <div className={FIELD_LABEL}>Phone</div>
            <EditableField type="phone" label="Phone" value={contact.phone} placeholder="Add phone" onSave={save('phone')} />
          </div>
          <div>
            <div className={FIELD_LABEL}>Source</div>
            <EditableField type="select" label="Source" value={contact.source} options={sourceOptions} onSave={save('source')} />
          </div>
        </div>
      </section>
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
      {showServices && !isTerminalStatus(contact.status) && (
        <section aria-label="Billing" className="pb-3">
          <h3 className={HEAD}>Billing</h3>
          <div className="px-3.5 text-[12.5px]">
            <Suspense fallback={<p className="text-muted-foreground">Loading services...</p>}>
              <CompactQuoteEditor contact={contact} disabled={fieldSaving} />
            </Suspense>
          </div>
          <Link to={links.contactTab(contact.id, 'billing')} className="mt-2 block px-3.5 text-[12px] text-muted-foreground underline-offset-2 hover:underline">
            Open billing
          </Link>
        </section>
      )}
    </div>
  );
}
