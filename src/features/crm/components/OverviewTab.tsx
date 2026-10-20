import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useIsMutating } from '@tanstack/react-query';
import type { Contact } from '@/api/contacts';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';
import { ContactNotesCard } from '@/components/contacts/ContactNotesCard';
import { HouseholdPanel } from '@/components/contacts/HouseholdPanel';
import { Panel } from '@/components/layout/page';
import { useContactStatuses, useLeadSources } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { isSystemStatus } from '@/lib/contactStatus';
import { formatDate } from '@/lib/format';
import { contactFieldMutationKey, useContactFieldSave } from '../hooks';
import { quoteOpMutationKey } from '../lib/quotes';
import { addedAt } from '../lib/sections';
import { TIER_OPTIONS, tierValue, UNRANKED } from '../lib/tiers';
import { EditableField } from './EditableField';
import { FieldRow, STATIC_VALUE } from './FieldRow';

// Loaded with the first record that shows it, so the record shell never carries the editor.
const CompactQuoteEditor = lazy(() => import('./quotes/CompactQuoteEditor').then((m) => ({ default: m.CompactQuoteEditor })));

/**
 * Overview is the contact: Details, Billing, Spouse and Household side by side, Notes under
 * them. Every value is edited in place and saved on Enter, Tab or blur. Billing is the
 * compact services editor, the same quote writes as the Billing tab, so a price is entered
 * right here; the upsells and organization editing stay on Billing. The cards size to the
 * PANE (auto-fit, 300px minimum), never to a viewport breakpoint, because the record sits
 * beside the index. The Spouse rows are always open, never behind a disclosure.
 *
 * A quote save re-derives the status from the one it read, so the status and the quotes
 * each wait for the other: the Status field holds while a quote saves, and the services
 * editor holds while a field save runs.
 */
export function OverviewTab({ contact }: { contact: Contact }) {
  const save = useContactFieldSave(contact);
  const quoteSaving = useIsMutating({ mutationKey: quoteOpMutationKey(contact.id) }) > 0;
  const fieldSaving = useIsMutating({ mutationKey: contactFieldMutationKey(contact.id) }) > 0;
  const statuses = useContactStatuses();
  const sources = useLeadSources();

  // A system status (signer only) is shown, never offered.
  const statusOptions = (statuses.data ?? [])
    .filter((s) => !isSystemStatus(s.key) || s.key === contact.status)
    .map((s) => ({ value: s.key, label: s.label }));
  const sourceOptions = (sources.data ?? [])
    .filter((s) => s.is_active || s.key === contact.source)
    .map((s) => ({ value: s.key, label: s.label }));
  const spouseName = [contact.spouse_first_name, contact.spouse_last_name].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-4">
        <Panel title="Details" bodyClassName="py-1.5">
          <FieldRow label="First name">
            <EditableField type="text" label="First name" value={contact.first_name} onSave={save('first_name')} />
          </FieldRow>
          <FieldRow label="Last name">
            <EditableField type="text" label="Last name" value={contact.last_name} onSave={save('last_name')} />
          </FieldRow>
          <FieldRow label="Email" align="top">
            <ContactEmailsManager contactId={contact.id} kind="primary" />
          </FieldRow>
          <FieldRow label="Phone">
            <EditableField type="phone" label="Phone" value={contact.phone} onSave={save('phone')} />
          </FieldRow>
          <FieldRow label="Business">
            <EditableField type="text" label="Business" value={contact.business_name} onSave={save('business_name')} />
          </FieldRow>
          <FieldRow label="Status">
            {isSystemStatus(contact.status) ? (
              <span className={STATIC_VALUE}>{statuses.data?.find((s) => s.key === contact.status)?.label ?? contact.status}</span>
            ) : (
              <EditableField type="select" label="Status" value={contact.status} options={statusOptions} disabled={quoteSaving} onSave={save('status')} />
            )}
          </FieldRow>
          <FieldRow label="Tier">
            <EditableField
              type="select"
              label="Tier"
              value={contact.tier ?? UNRANKED}
              options={TIER_OPTIONS}
              onSave={(v) => save('tier')(tierValue(v))}
            />
          </FieldRow>
          <FieldRow label="Source">
            <EditableField type="select" label="Source" value={contact.source} options={sourceOptions} onSave={save('source')} />
          </FieldRow>
          <FieldRow label="Added">
            <span className={STATIC_VALUE}>{formatDate(addedAt(contact))}</span>
          </FieldRow>
          <FieldRow label="Client since">
            <EditableField type="date" label="Client since" value={contact.client_since} placeholder="Set date" onSave={save('client_since')} />
          </FieldRow>
          <FieldRow label="Address">
            <EditableField type="text" label="Street" value={contact.mailing_street} placeholder="Set address" onSave={save('mailing_street')} />
          </FieldRow>
          <FieldRow label="City">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <EditableField type="text" label="City" value={contact.mailing_city} placeholder="City" onSave={save('mailing_city')} />
              </div>
              <div className="w-14 shrink-0">
                <EditableField type="text" label="State" value={contact.mailing_state} placeholder="ST" onSave={save('mailing_state')} />
              </div>
              <div className="w-20 shrink-0">
                <EditableField type="text" label="ZIP" value={contact.mailing_zip} placeholder="ZIP" onSave={save('mailing_zip')} />
              </div>
            </div>
          </FieldRow>
        </Panel>

        <Panel
          title="Billing"
          action={
            <Link to={links.contactTab(contact.id, 'billing')} className="text-[12px] normal-case tracking-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Open billing
            </Link>
          }
          bodyClassName="px-3.5 py-2.5"
        >
          <Suspense fallback={<p className="text-[13px] text-muted-foreground">Loading services...</p>}>
            <CompactQuoteEditor contact={contact} disabled={fieldSaving} />
          </Suspense>
        </Panel>

        <Panel title={spouseName ? `Spouse: ${spouseName}` : 'Spouse'} bodyClassName="py-1.5">
          <FieldRow label="First name">
            <EditableField type="text" label="Spouse first name" value={contact.spouse_first_name} onSave={save('spouse_first_name')} />
          </FieldRow>
          <FieldRow label="Last name">
            <EditableField type="text" label="Spouse last name" value={contact.spouse_last_name} onSave={save('spouse_last_name')} />
          </FieldRow>
          <FieldRow label="Email" align="top">
            <ContactEmailsManager contactId={contact.id} kind="spouse" />
          </FieldRow>
          <FieldRow label="Phone">
            <EditableField type="phone" label="Spouse phone" value={contact.spouse_phone} onSave={save('spouse_phone')} />
          </FieldRow>
        </Panel>

        <HouseholdPanel contactId={contact.id} />
      </div>

      <ContactNotesCard contactId={contact.id} />
    </div>
  );
}
