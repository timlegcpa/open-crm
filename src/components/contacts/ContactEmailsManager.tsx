import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  addContactEmail,
  deleteContactEmail,
  EMAIL_LABELS,
  listContactEmails,
  setDefaultContactEmail,
  updateContactEmail,
  type ContactEmail,
  type EmailKind,
  type EmailLabel,
} from '@/api/contactEmails';
import { queryKeys } from '@/api/queryKeys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { changeSignInEmail, getPortalAccess, portalKeys, signInAccounts } from '@/features/portal/api';
import { getErrorMessage } from '@/lib/errors';

const KIND_TITLES: Record<EmailKind, string> = { primary: 'Contact emails', spouse: 'Spouse emails' };
const LABEL_TEXT: Record<EmailLabel, string> = { business: 'Business', personal: 'Personal', other: 'Other' };

const isEmail = (value: string) => z.string().email().safeParse(value).success;
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A portal account this address signs in to: editing the address moves the sign-in too. */
interface SignIn {
  accountId: string;
  email: string;
}

function LabelSelect({ value, onChange, ariaLabel }: { value: EmailLabel; onChange: (v: EmailLabel) => void; ariaLabel: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as EmailLabel)}>
      <SelectTrigger aria-label={ariaLabel} className="w-32"><SelectValue /></SelectTrigger>
      <SelectContent>
        {EMAIL_LABELS.map((l) => <SelectItem key={l} value={l}>{LABEL_TEXT[l]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * Addresses per kind. contacts.email / spouse_email follow the default row of each kind, so
 * an address changes ONLY here (or through the RPC this calls), never by a contact patch.
 * Pass `kind` to manage one kind where it belongs (primary in Details, spouse in Spouse,
 * primary on the board's card bar).
 *
 * An address a portal account signs in with is marked "Portal sign-in". Editing it goes
 * through change-portal-email, which moves the sign-in and the contact's address together;
 * a plain row update would leave the person signing in with the old one.
 */
export function ContactEmailsManager({ contactId, kind: onlyKind }: { contactId: string; kind?: EmailKind }) {
  const queryClient = useQueryClient();
  const emails = useQuery({
    queryKey: queryKeys.contactEmails.forContact(contactId),
    queryFn: () => listContactEmails(contactId),
  });
  const access = useQuery({ queryKey: portalKeys.access(contactId), queryFn: () => getPortalAccess(contactId) });
  const [error, setError] = useState<string | null>(null);
  const signIns: SignIn[] = signInAccounts(access.data?.accounts ?? []).map((a) => ({
    accountId: a.id,
    email: a.invited_email as string,
  }));

  // A trigger rewrites the contact's mirrored address, so the contact is stale too; a
  // sign-in change also moves the portal account's address.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.contactEmails.forContact(contactId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    void queryClient.invalidateQueries({ queryKey: portalKeys.access(contactId) });
  };

  const run = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onMutate: () => setError(null),
    onError: (err) => setError(getErrorMessage(err, 'That change was not saved.')),
    onSettled: refresh,
  });

  if (emails.isPending) return <p className="text-sm text-muted-foreground">Loading emails...</p>;
  if (emails.isError) return <p role="alert" className="text-sm text-destructive">Could not load emails: {getErrorMessage(emails.error)}</p>;

  const kinds: EmailKind[] = onlyKind ? [onlyKind] : ['primary', 'spouse'];
  return (
    <section aria-label={onlyKind ? KIND_TITLES[onlyKind] : 'Emails'} className="flex flex-col gap-4">
      {!onlyKind && <h2 className="text-base font-semibold">Emails</h2>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {kinds.map((kind) => (
        <EmailKindSection
          key={kind}
          kind={kind}
          contactId={contactId}
          rows={emails.data.filter((e) => e.kind === kind)}
          showTitle={!onlyKind}
          signIns={signIns}
          busy={run.isPending}
          run={(action) => run.mutateAsync(action).then(() => true, () => false)}
        />
      ))}
    </section>
  );
}

function EmailKindSection({
  kind,
  contactId,
  rows,
  busy,
  run,
  showTitle,
  signIns,
}: {
  kind: EmailKind;
  contactId: string;
  rows: ContactEmail[];
  showTitle: boolean;
  signIns: SignIn[];
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const hasDefault = rows.some((r) => r.is_default);
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState<EmailLabel>('other');
  const [makeDefault, setMakeDefault] = useState<boolean | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const wantDefault = makeDefault ?? !hasDefault;
  const title = KIND_TITLES[kind];

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!isEmail(value)) {
      setFormError('Enter a valid email address.');
      return;
    }
    setFormError(null);
    // Two requests. If the second fails the address is already saved, so the form
    // clears and the error says what did and did not happen.
    let added = false;
    const ok = await run(async () => {
      const id = await addContactEmail({ contactId, kind, email: value, label });
      added = true;
      if (!wantDefault) return;
      try {
        await setDefaultContactEmail(id, contactId, kind);
      } catch (err) {
        throw new Error(`The address was added but not made the default: ${getErrorMessage(err)}`);
      }
    });
    if (ok || added) {
      // Keep an address typed while this one was saving.
      setEmail((current) => (current.trim() === value ? '' : current));
      setLabel('other');
      setMakeDefault(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {showTitle && <h3 className="text-sm font-semibold">{title}</h3>}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No addresses.</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <EmailRow key={row.id} row={row} signIn={signIns.find((s) => sameAddress(s.email, row.email))} busy={busy} run={run} />
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} noValidate className="flex flex-wrap items-end gap-2" aria-label={`Add ${title.toLowerCase()}`}>
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5">
          <Label htmlFor={`new-email-${kind}`}>New address</Label>
          <Input id={`new-email-${kind}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full max-w-64" />
        </div>
        <LabelSelect value={label} onChange={setLabel} ariaLabel={`Label for new ${kind} address`} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={wantDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
          Make default
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>Add</Button>
        {formError && <p className="w-full text-sm text-destructive">{formError}</p>}
      </form>
    </div>
  );
}

function EmailRow({
  row,
  signIn,
  busy,
  run,
}: {
  row: ContactEmail;
  signIn?: SignIn;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [email, setEmail] = useState(row.email);
  const [label, setLabel] = useState<EmailLabel>(row.label);
  const [rowError, setRowError] = useState<string | null>(null);

  if (editing) {
    const save = async () => {
      const value = email.trim();
      if (!isEmail(value)) {
        setRowError('Enter a valid email address.');
        return;
      }
      setRowError(null);
      const action = signIn && !sameAddress(value, row.email)
        ? async () => {
            if (label !== row.label) await updateContactEmail(row.id, { email: row.email, label });
            // Compare-and-swapped on the address this row showed.
            // A listed address is renamed in place by the database half, label and all.
            await changeSignInEmail(signIn.accountId, value, signIn.email);
          }
        : () => updateContactEmail(row.id, { email: value, label });
      if (await run(action)) setEditing(false);
    };
    return (
      <li className="flex flex-wrap items-center gap-2">
        <Input aria-label={`Edit ${row.email}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full max-w-64" />
        <LabelSelect value={label} onChange={setLabel} ariaLabel={`Label for ${row.email}`} />
        <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        {signIn && <p className="w-full text-xs text-muted-foreground">This address signs in to the portal. Changing it changes the sign-in too.</p>}
        {rowError && <p className="w-full text-sm text-destructive">{rowError}</p>}
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span>{row.email}</span>
      <Badge variant="secondary">{LABEL_TEXT[row.label]}</Badge>
      {signIn && <Badge variant="outline">Portal sign-in</Badge>}
      {row.is_default ? (
        <Badge>Default</Badge>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => setDefaultContactEmail(row.id, row.contact_id, row.kind))}
        >
          Make default
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
      {confirming ? (
        <>
          <Button size="xs" variant="destructive" disabled={busy} onClick={() => void run(() => deleteContactEmail(row.id))}>
            Confirm remove {row.email}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
        </>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => setConfirming(true)}>Remove</Button>
      )}
    </li>
  );
}
