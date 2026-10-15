import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createContact } from '@/api/contacts';
import { addContactNote } from '@/api/contactNotes';
import { queryKeys } from '@/api/queryKeys';
import { PAGE, PageHeader, Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { useContactStatuses, useLeadSources, useServiceTypes } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { auditContactCreate, createQuotes } from '@/features/crm/api';
import { intakeQuotes, intakeSchema, type IntakeForm } from '@/features/crm/lib/intake';
import { isSystemStatus } from '@/lib/contactStatus';
import { dateInputToTimestamp } from '@/lib/dates';
import { getErrorMessage } from '@/lib/errors';

/** The database's own column defaults, preselected when the pick-list offers them. */
const DEFAULT_STATUS = 'new_lead';
const DEFAULT_SOURCE = 'other';

const EMPTY: IntakeForm = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  business_name: '',
  status: '',
  source: '',
  added_date: '',
  note: '',
};

type Errors = Partial<Record<keyof IntakeForm | 'services' | 'form', string>>;

const blankToNull = (value: string) => (value === '' ? null : value);

/**
 * Add a contact. A full page with no <form>, so Enter never submits half a contact. First
 * name is required; status and source are pills; "Date added" can be backdated (a LOCAL
 * day, never UTC midnight). Priced services become quotes; the first note goes to the
 * notes table; the create is audited (fail-open).
 */
export function ContactIntake() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useContactStatuses();
  const sources = useLeadSources();
  const services = useServiceTypes();
  const statusList = (statuses.data ?? []).filter((s) => !isSystemStatus(s.key));
  const sourceList = (sources.data ?? []).filter((s) => s.is_active);
  const serviceList = (services.data ?? []).filter((s) => s.is_active);

  const [form, setForm] = useState<IntakeForm>(EMPTY);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const status = form.status || (statusList.some((s) => s.key === DEFAULT_STATUS) ? DEFAULT_STATUS : (statusList[0]?.key ?? ''));
  const source = form.source || (sourceList.some((s) => s.key === DEFAULT_SOURCE) ? DEFAULT_SOURCE : (sourceList[0]?.key ?? ''));
  const set = (field: keyof IntakeForm) => (value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const save = async () => {
    if (busy) return;
    const parsed = intakeSchema.safeParse({ ...form, status, source });
    const next: Errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) next[issue.path[0] as keyof IntakeForm] ??= issue.message;
    }
    const check = intakeQuotes('pending', status, serviceList, amounts);
    if ('error' in check) next.services = check.error;
    if (!parsed.success || 'error' in check) {
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const v = parsed.data;
    let id: string;
    try {
      id = await createContact({
        first_name: v.first_name,
        last_name: v.last_name,
        email: blankToNull(v.email),
        phone: blankToNull(v.phone),
        business_name: blankToNull(v.business_name),
        status: v.status,
        source: v.source,
        submitted_at: v.added_date ? dateInputToTimestamp(v.added_date) : null,
      });
    } catch (err) {
      setErrors({ form: getErrorMessage(err, 'The contact was not saved.') });
      setBusy(false);
      return;
    }
    void auditContactCreate(id);
    const quotes = intakeQuotes(id, v.status, serviceList, amounts);
    if ('rows' in quotes && quotes.rows.length > 0) {
      try {
        await createQuotes(quotes.rows);
      } catch (err) {
        toast.error('Contact saved; its quotes were not.', { description: getErrorMessage(err) });
      }
    }
    if (v.note !== '') {
      try {
        await addContactNote(id, v.note, 'note');
      } catch (err) {
        toast.error('Contact saved; its note was not.', { description: getErrorMessage(err) });
      }
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    navigate(links.contact(id));
  };

  const field = (name: keyof IntakeForm, label: string, type = 'text', autoFocus = false) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`intake-${name}`}>{label}</Label>
      <Input
        id={`intake-${name}`}
        type={type}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        value={form[name]}
        onChange={(e) => set(name)(e.target.value)}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `intake-${name}-error` : undefined}
      />
      {errors[name] && <p id={`intake-${name}-error`} className="text-sm text-destructive">{errors[name]}</p>}
    </div>
  );

  return (
    <>
      <PageHeader title="Add contact" actions={<Link to={links.contacts()} className="text-[13px] underline-offset-2 hover:underline">Back to contacts</Link>} />
      <div className={PAGE}>
        <div className="flex max-w-3xl flex-col gap-4">
          <Panel title="Contact" bodyClassName="flex flex-col gap-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {field('first_name', 'First name', 'text', true)}
              {field('last_name', 'Last name')}
              {field('email', 'Email', 'email')}
              {field('phone', 'Phone', 'tel')}
              {field('business_name', 'Business name')}
              <div className="flex flex-col gap-1.5">
                <Label id="intake-added-label">Date added</Label>
                <DatePicker
                  aria-labelledby="intake-added-label"
                  value={form.added_date}
                  onChange={set('added_date')}
                  placeholder="Today"
                  calendar={{ disabled: { after: new Date() } }}
                  className="w-full"
                />
                {errors.added_date && <p className="text-sm text-destructive">{errors.added_date}</p>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Status</span>
              <Segmented
                label="Status"
                value={status}
                onValueChange={set('status')}
                options={statusList.map((s) => ({ value: s.key, label: s.label }))}
                className="flex h-auto flex-wrap"
              />
              {errors.status && <p className="text-sm text-destructive">{errors.status}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Source</span>
              <Segmented
                label="Source"
                value={source}
                onValueChange={set('source')}
                options={sourceList.map((s) => ({ value: s.key, label: s.label }))}
                className="flex h-auto flex-wrap"
              />
              {errors.source && <p className="text-sm text-destructive">{errors.source}</p>}
            </div>
          </Panel>

          {serviceList.length > 0 && (
            <Panel title="Services" bodyClassName="flex flex-col gap-2 p-4">
              <p className="text-[13px] text-muted-foreground">
                {status === 'client' || status === 'one_time'
                  ? 'Priced services are saved as accepted.'
                  : 'Priced services are saved as proposed.'}{' '}
                Leave a service blank to skip it.
              </p>
              {serviceList.map((s) => (
                <div key={s.key} className="flex items-center gap-3">
                  <Label htmlFor={`intake-service-${s.key}`} className="w-40 shrink-0 text-[13px] font-normal">{s.label}</Label>
                  <Input
                    id={`intake-service-${s.key}`}
                    inputMode="decimal"
                    value={amounts[s.key] ?? ''}
                    onChange={(e) => setAmounts((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    className="h-8 w-32 text-[13px] tabular-nums"
                  />
                  <span className="text-[12px] text-muted-foreground">
                    {status === 'one_time' ? 'once' : s.default_cadence === 'monthly' ? 'a month' : s.default_cadence === 'annual' ? 'a year' : 'once'}
                  </span>
                </div>
              ))}
              {errors.services && <p role="alert" className="text-sm text-destructive">{errors.services}</p>}
            </Panel>
          )}

          <Panel title="First note" bodyClassName="flex flex-col gap-1.5 p-4">
            <Label htmlFor="intake-note">First note (optional)</Label>
            <Textarea id="intake-note" value={form.note} onChange={(e) => set('note')(e.target.value)} />
            {errors.note && <p className="text-sm text-destructive">{errors.note}</p>}
          </Panel>

          {errors.form && <p role="alert" className="text-sm text-destructive">{errors.form}</p>}
          <div>
            <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save contact'}</Button>
          </div>
        </div>
      </div>
    </>
  );
}
