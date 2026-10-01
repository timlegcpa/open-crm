import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateContact, type Contact, type ContactPatch, type ContactPatchColumn } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useContactStatuses, useLeadSources } from '@/hooks/usePickLists';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { dateInputToTimestamp, timestampToDateInput } from '@/lib/dates';
import { getErrorMessage } from '@/lib/errors';

type Kind = 'text' | 'tel' | 'date' | 'timestamp';

interface FieldDef {
  column: ContactPatchColumn;
  label: string;
  kind: Kind;
}

const SECTIONS: Array<{ title: string; fields: FieldDef[] }> = [
  {
    title: 'Contact',
    fields: [
      { column: 'first_name', label: 'First name', kind: 'text' },
      { column: 'last_name', label: 'Last name', kind: 'text' },
      { column: 'phone', label: 'Phone', kind: 'tel' },
      { column: 'business_name', label: 'Business name', kind: 'text' },
    ],
  },
  {
    title: 'Spouse',
    fields: [
      { column: 'spouse_first_name', label: 'Spouse first name', kind: 'text' },
      { column: 'spouse_last_name', label: 'Spouse last name', kind: 'text' },
      { column: 'spouse_phone', label: 'Spouse phone', kind: 'tel' },
    ],
  },
  {
    title: 'Mailing address',
    fields: [
      { column: 'mailing_street', label: 'Street', kind: 'text' },
      { column: 'mailing_city', label: 'City', kind: 'text' },
      { column: 'mailing_state', label: 'State', kind: 'text' },
      { column: 'mailing_zip', label: 'ZIP', kind: 'text' },
    ],
  },
  {
    title: 'Dates',
    fields: [
      { column: 'date_of_birth', label: 'Date of birth', kind: 'date' },
      { column: 'spouse_date_of_birth', label: 'Spouse date of birth', kind: 'date' },
      { column: 'client_since', label: 'Client since', kind: 'date' },
      { column: 'submitted_at', label: 'Submitted', kind: 'timestamp' },
    ],
  },
];

const FIELD_KINDS = new Map<ContactPatchColumn, Kind>(SECTIONS.flatMap((s) => s.fields.map((f) => [f.column, f.kind])));

/** Columns that are NOT NULL in the table: an empty value is stored as '', never null. */
const NOT_NULL_TEXT = new Set<ContactPatchColumn>(['first_name', 'last_name']);

type Draft = Record<ContactPatchColumn, string>;

function toDraft(c: Contact): Draft {
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    phone: c.phone ?? '',
    business_name: c.business_name ?? '',
    spouse_first_name: c.spouse_first_name ?? '',
    spouse_last_name: c.spouse_last_name ?? '',
    spouse_phone: c.spouse_phone ?? '',
    mailing_street: c.mailing_street ?? '',
    mailing_city: c.mailing_city ?? '',
    mailing_state: c.mailing_state ?? '',
    mailing_zip: c.mailing_zip ?? '',
    date_of_birth: c.date_of_birth ?? '',
    spouse_date_of_birth: c.spouse_date_of_birth ?? '',
    client_since: c.client_since ?? '',
    submitted_at: timestampToDateInput(c.submitted_at),
    status: c.status,
    source: c.source,
  };
}

/** Only the columns the owner changed, converted to what the column stores. */
function changedColumns(baseline: Draft, draft: Draft): ContactPatch {
  const patch: ContactPatch = {};
  for (const column of Object.keys(draft) as ContactPatchColumn[]) {
    if (draft[column] === baseline[column]) continue;
    const kind = FIELD_KINDS.get(column);
    const raw = kind === 'text' || kind === 'tel' ? draft[column].trim() : draft[column];
    if (kind === 'timestamp') patch[column] = raw === '' ? null : dateInputToTimestamp(raw);
    else if (raw === '' && !NOT_NULL_TEXT.has(column)) patch[column] = null;
    else patch[column] = raw;
  }
  return patch;
}

/**
 * The contact's own columns, edited together and saved explicitly. Email addresses are
 * shown but edited in the emails manager: the database mirrors them from there.
 */
export function ContactFieldsForm({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const statuses = useContactStatuses();
  const sources = useLeadSources();
  const [baseline, setBaseline] = useState<Draft>(() => toDraft(contact));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const patch = changedColumns(baseline, draft);
  const dirty = Object.keys(patch).length > 0;
  const sourceOptions = (sources.data ?? []).filter((s) => s.is_active || s.key === draft.source);

  // The draft that was sent travels with the mutation: an edit typed while the save is
  // in flight stays unsaved instead of being marked saved with it.
  const save = useMutation({
    mutationFn: (sent: Draft) => updateContact(contact.id, changedColumns(baseline, sent)),
    onSuccess: (_, sent) => {
      setBaseline(sent);
      setMessage({ kind: 'ok', text: 'Saved.' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    },
    onError: (err) => setMessage({ kind: 'error', text: getErrorMessage(err, 'The changes were not saved.') }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || save.isPending) return;
    setMessage(null);
    save.mutate(draft);
  };

  const set = (column: ContactPatchColumn) => (value: string) => setDraft((prev) => ({ ...prev, [column]: value }));

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-label="Contact details">
      {SECTIONS.map((section) => (
        <fieldset key={section.title} className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{section.title}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {section.fields.map((f) => (
              <div key={f.column} className="flex flex-col gap-1.5">
                <Label htmlFor={`field-${f.column}`}>{f.label}</Label>
                <Input
                  id={`field-${f.column}`}
                  type={f.kind === 'timestamp' ? 'date' : f.kind}
                  value={draft[f.column]}
                  onChange={(e) => set(f.column)(e.target.value)}
                />
              </div>
            ))}
            {section.title === 'Contact' && <ReadOnly label="Email" value={contact.email} />}
            {section.title === 'Spouse' && <ReadOnly label="Spouse email" value={contact.spouse_email} />}
          </div>
        </fieldset>
      ))}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Pipeline</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="field-status">Status</Label>
            <Select value={draft.status} onValueChange={set('status')}>
              <SelectTrigger id="field-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(statuses.data ?? []).map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="field-source">Source</Label>
            <Select value={draft.source} onValueChange={set('source')}>
              <SelectTrigger id="field-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                {sourceOptions.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || save.isPending}>{save.isPending ? 'Saving...' : 'Save changes'}</Button>
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-sm text-destructive' : 'text-sm'}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}

function ReadOnly({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm text-muted-foreground">{value ?? 'None'} (edit under Emails)</span>
    </div>
  );
}
