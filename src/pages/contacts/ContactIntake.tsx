import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createContact } from '@/api/contacts';
import { addContactNote } from '@/api/contactNotes';
import { queryKeys } from '@/api/queryKeys';
import { useContactStatuses, useLeadSources } from '@/hooks/usePickLists';
import { contactIntakeSchema, type ContactIntakeForm } from '@/schemas/contact';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { dateInputToTimestamp } from '@/lib/dates';
import { getErrorMessage } from '@/lib/errors';

/** The database's own column defaults, preselected when the pick-list offers them. */
const DEFAULT_STATUS = 'new_lead';
const DEFAULT_SOURCE = 'other';

const EMPTY: ContactIntakeForm = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  business_name: '',
  status: '',
  source: '',
  submitted_date: '',
  note: '',
};

type Errors = Partial<Record<keyof ContactIntakeForm | 'form', string>>;

function blankToNull(value: string): string | null {
  return value === '' ? null : value;
}

export function ContactIntake() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useContactStatuses();
  const sources = useLeadSources();
  const activeSources = (sources.data ?? []).filter((s) => s.is_active);

  const [form, setForm] = useState<ContactIntakeForm>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const statusList = statuses.data ?? [];
  const status =
    form.status || (statusList.some((s) => s.key === DEFAULT_STATUS) ? DEFAULT_STATUS : statusList[0]?.key ?? '');
  const source =
    form.source ||
    (activeSources.some((s) => s.key === DEFAULT_SOURCE) ? DEFAULT_SOURCE : activeSources[0]?.key ?? '');

  const set = (field: keyof ContactIntakeForm) => (value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const parsed = contactIntakeSchema.safeParse({ ...form, status, source });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof ContactIntakeForm;
        next[key] ??= issue.message;
      }
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
        submitted_at: v.submitted_date ? dateInputToTimestamp(v.submitted_date) : null,
      });
    } catch (err) {
      setErrors({ form: getErrorMessage(err, 'The contact was not saved.') });
      setBusy(false);
      return;
    }
    let notice: string | undefined;
    if (v.note !== '') {
      try {
        await addContactNote(id, v.note, 'note');
      } catch (err) {
        notice = `The contact was saved, but the note was not: ${getErrorMessage(err)}`;
      }
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    navigate(`/contacts/${id}`, { state: notice ? { notice } : undefined });
  };

  const field = (name: keyof ContactIntakeForm, label: string, type = 'text') => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`intake-${name}`}>{label}</Label>
      <Input
        id={`intake-${name}`}
        type={type}
        value={form[name]}
        onChange={(e) => set(name)(e.target.value)}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `intake-${name}-error` : undefined}
      />
      {errors[name] && <p id={`intake-${name}-error`} className="text-sm text-destructive">{errors[name]}</p>}
    </div>
  );

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Add contact</h1>
        <Link to="/contacts" className="text-sm underline">Back to contacts</Link>
      </div>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {field('first_name', 'First name')}
          {field('last_name', 'Last name')}
          {field('email', 'Email', 'email')}
          {field('phone', 'Phone', 'tel')}
          {field('business_name', 'Business name')}
          {field('submitted_date', 'Submitted date', 'date')}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-status">Status</Label>
            <Select value={status} onValueChange={set('status')}>
              <SelectTrigger id="intake-status"><SelectValue placeholder="Choose a status" /></SelectTrigger>
              <SelectContent>
                {statusList.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {errors.status && <p className="text-sm text-destructive">{errors.status}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-source">Source</Label>
            <Select value={source} onValueChange={set('source')}>
              <SelectTrigger id="intake-source"><SelectValue placeholder="Choose a source" /></SelectTrigger>
              <SelectContent>
                {activeSources.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {errors.source && <p className="text-sm text-destructive">{errors.source}</p>}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="intake-note">First note (optional)</Label>
          <Textarea id="intake-note" value={form.note} onChange={(e) => set('note')(e.target.value)} />
          {errors.note && <p className="text-sm text-destructive">{errors.note}</p>}
        </div>
        {errors.form && <p role="alert" className="text-sm text-destructive">{errors.form}</p>}
        <div>
          <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save contact'}</Button>
        </div>
      </form>
    </div>
  );
}
