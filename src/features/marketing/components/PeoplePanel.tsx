import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { contactDisplayName } from '@/api/contacts';
import type { ContactStatus, LeadSource } from '@/api/pickLists';
import { links } from '@/features/links';
import { SELECTABLE_STATUSES } from '@/lib/contactStatus';
import type { PageContact } from '../api';
import type { ContactField } from '../useMarketingData';

/** What a list lets you change. A price is a quote, so it links to Billing instead. */
export type DrillField = ContactField | 'price';

export interface DrillPerson {
  contact: PageContact;
  /** A short fact about this person in this list ("Added Apr 7, 2026"). */
  note?: string;
}

export interface MarketingDrill {
  title: string;
  sub: string;
  people: DrillPerson[];
  fields: DrillField[];
}

type SaveField = (id: string, field: ContactField, value: string | null) => Promise<void>;

/**
 * The right bar: the people behind a clicked figure, with the fields that move the figure
 * editable in place. Every write is the record's own (updateContact, the allow-listed
 * columns, one field at a time); the list on the left recomputes as you go. Status history
 * and client_since stamping belong to the database, never to this bar.
 */
export function PeoplePanel({
  drill,
  sources,
  statuses,
  onSave,
  onClose,
}: {
  drill: MarketingDrill;
  sources: LeadSource[];
  statuses: ReadonlyMap<string, ContactStatus>;
  onSave: SaveField;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label={drill.title}
      className="flex w-full shrink-0 flex-col rounded-lg border border-border bg-card xl:sticky xl:top-4 xl:h-[calc(100vh-8rem)] xl:w-[360px]"
    >
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{drill.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{drill.sub}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close list">
          <X />
        </Button>
      </div>
      <ScrollArea fitWidth className="max-h-[420px] min-h-0 flex-1 xl:max-h-none">
        <ul className="divide-y divide-border">
          {drill.people.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">Nobody here.</li>
          ) : (
            drill.people.map((p) => (
              <PersonRow key={p.contact.id} person={p} fields={drill.fields} sources={sources} statuses={statuses} onSave={onSave} />
            ))
          )}
        </ul>
      </ScrollArea>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Edits save to the contact. The numbers update as you go.</p>
    </aside>
  );
}

function PersonRow({
  person,
  fields,
  sources,
  statuses,
  onSave,
}: {
  person: DrillPerson;
  fields: DrillField[];
  sources: LeadSource[];
  statuses: ReadonlyMap<string, ContactStatus>;
  onSave: SaveField;
}) {
  const c = person.contact;
  const name = contactDisplayName(c);
  // A failed write is reported by the mutation (a toast), not by this row: the optimistic
  // change may already have moved this person out of the list, unmounting the row.
  const save = (field: ContactField) => async (value: string | null) => {
    try {
      await onSave(c.id, field, value);
    } catch {
      // Reported by the mutation's onError.
    }
  };
  // A retired source stays shown on the contact that already has it, never offered to others.
  const sourceOptions = sources.filter((s) => s.is_active || s.key === c.source);
  // The system stage (a signer-only contact) is shown, never offered.
  const stageOptions: string[] = (SELECTABLE_STATUSES as readonly string[]).includes(c.status)
    ? [...SELECTABLE_STATUSES]
    : [...SELECTABLE_STATUSES, c.status];

  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <Link to={links.contact(c.id)} className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground hover:underline">
          {name}
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground">{statuses.get(c.status)?.label ?? c.status}</span>
      </div>
      {person.note && <p className="text-xs text-muted-foreground">{person.note}</p>}
      <dl className="space-y-1">
        {fields.includes('source') && (
          <Row label="Source">
            <Select value={c.source} onValueChange={(v) => void save('source')(v)}>
              <SelectTrigger className="h-7 text-[13px]" aria-label={`Source for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}
        {fields.includes('status') && (
          <Row label="Stage">
            <Select value={c.status} onValueChange={(v) => void save('status')(v)}>
              <SelectTrigger className="h-7 text-[13px]" aria-label={`Stage for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stageOptions.map((key) => (
                  <SelectItem key={key} value={key} disabled={!(SELECTABLE_STATUSES as readonly string[]).includes(key)}>
                    {statuses.get(key)?.label ?? key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}
        {fields.includes('client_since') && (
          <Row label="Client since">
            <DatePicker
              value={c.client_since}
              onChange={(v) => void save('client_since')(v || null)}
              placeholder="Set date"
              aria-label={`Client since for ${name}`}
              className="h-7 w-full text-[13px]"
            />
          </Row>
        )}
        {fields.includes('price') && (
          <Row label="Price">
            <Link to={links.contactTab(c.id, 'billing')} className="text-[13px] text-link hover:underline">
              Set price in Billing
            </Link>
          </Row>
        )}
      </dl>
    </li>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-center gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
