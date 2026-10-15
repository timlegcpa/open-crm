import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { listContacts } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useContactStatuses, useByKey } from '@/hooks/usePickLists';
import { getErrorMessage } from '@/lib/errors';
import { findContactsByEmail, getSigners, manageSigner, type EnvelopePrimaryContact, type ManageSignerAction, type SignerWithContact } from '../api';
import { SIGNER_ROLES, SIGNER_ROLE_LABELS, type SignerInput, type SignerRole, type VerificationLevel } from '../contract';
import { esignKeys } from '../keys';
import { escapeLikePattern } from '../lib/likePattern';
import { toE164 } from '../lib/phone';
import { colorForIndex } from '../lib/signerColors';
import { resolveSignerName, resolveSignerNameParts } from '../lib/signerName';
import { buildSignerPickerOptions, nextSignerOrder, optionMatches, type SignerPickerOption } from '../lib/signerPicker';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A one-click "add this person" chip; the order is filled in when it is clicked. */
interface Suggestion {
  key: string;
  label: string;
  subtitle: string;
  signer: Omit<SignerInput, 'order'>;
}

/** The composer's signers step: who signs, in what order, and (for High) their phone. */
export function SignersStep({
  envelopeId,
  verificationLevel,
  primaryContact,
}: {
  envelopeId: string;
  verificationLevel: VerificationLevel;
  primaryContact: EnvelopePrimaryContact | null;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; signer?: SignerWithContact } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SignerWithContact | null>(null);
  const signers = useQuery({ queryKey: esignKeys.signers(envelopeId), queryFn: () => getSigners(envelopeId) });
  const list = useMemo(() => signers.data ?? [], [signers.data]);

  const mutation = useMutation({
    mutationFn: (args: { action: ManageSignerAction; signer: SignerInput }) => manageSigner(envelopeId, args.action, args.signer),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.signers(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.fields(envelopeId) });
      // A new signer may have created a signer-only contact, or filled a co-signer's name in.
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success(vars.action === 'add' ? 'Signer added.' : vars.action === 'update' ? 'Signer updated.' : 'Signer removed.');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The signer was not saved. Try again.')),
  });

  // One answer to "is this person already on the envelope?": the signer's OWN address.
  const existingEmails = useMemo(() => new Set(list.map((s) => s.email.trim().toLowerCase()).filter(Boolean)), [list]);
  const existingContactIds = useMemo(() => new Set(list.map((s) => s.contact_id).filter((id): id is string => !!id)), [list]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    const seen = new Set(existingEmails);
    const primaryEmail = (primaryContact?.email ?? '').trim().toLowerCase();
    if (primaryContact && primaryEmail && !seen.has(primaryEmail)) {
      seen.add(primaryEmail);
      out.push({
        key: `primary:${primaryEmail}`,
        label: `Add ${resolveSignerName({ email: primaryEmail, contact: primaryContact })}`,
        subtitle: `The envelope's contact · ${primaryEmail}`,
        signer: {
          email: primaryEmail,
          first_name: primaryContact.first_name || undefined,
          last_name: primaryContact.last_name || undefined,
          // Only a number already in E.164; anything else would light up phone_last_four and
          // hide the missing-phone warning while the code goes to an unreachable number.
          phone: toE164(primaryContact.phone),
          role: 'primary',
          contact_id: primaryContact.id,
        },
      });
    }
    // Each signer's contact may record a spouse: offer them as a co-signer.
    const contacts = [primaryContact, ...list.map((s) => s.contact)];
    for (const c of contacts) {
      const email = (c?.spouse_email ?? '').trim().toLowerCase();
      if (!c || !email || seen.has(email)) continue;
      seen.add(email);
      const first = (c.spouse_first_name ?? '').trim();
      const last = (c.spouse_last_name ?? '').trim();
      const phone = 'spouse_phone' in c ? toE164((c as EnvelopePrimaryContact).spouse_phone) : undefined;
      out.push({
        key: `co_signer:${email}`,
        label: `Add co-signer: ${`${first} ${last}`.trim() || email}`,
        subtitle: email,
        signer: { email, first_name: first || undefined, last_name: last || undefined, phone, role: 'co_signer', contact_id: c.id },
      });
    }
    return out;
  }, [primaryContact, list, existingEmails]);

  const isHigh = verificationLevel === 'high';
  const missingPhone = isHigh ? list.filter((s) => !s.phone_last_four).length : 0;

  return (
    <Panel
      title="Signers"
      action={
        <Button size="xs" onClick={() => setDialog({ mode: 'add' })}>
          <Plus aria-hidden="true" />
          Add signer
        </Button>
      }
      bodyClassName="flex flex-col gap-3 p-3.5"
    >
      <p className="text-[13px] text-muted-foreground">The people who sign, in order. Each gets a link by email.</p>

      {signers.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the signers: {getErrorMessage(signers.error)}
        </p>
      )}

      {signers.isSuccess && list.length === 0 && (
        <p className="flex items-center gap-2 rounded-md border border-warning bg-warning-light px-3 py-2 text-sm text-warning-dark">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          Add at least one signer to send.
        </p>
      )}

      {missingPhone > 0 && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-destructive bg-destructive-light px-3 py-2 text-sm text-destructive-dark">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          High verification: {missingPhone} signer{missingPhone === 1 ? ' has' : 's have'} no phone. Edit each to add one.
        </p>
      )}

      {suggestions.map((s) => (
        <Button
          key={s.key}
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ action: 'add', signer: { ...s.signer, order: nextSignerOrder(list) } })}
          className="h-auto w-full justify-start gap-3 border-success bg-success-light px-3 py-2 text-left text-success-dark hover:bg-success-light"
        >
          <UserPlus className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{s.label}</span>
            <span className="truncate text-xs">{s.subtitle}</span>
          </span>
        </Button>
      ))}

      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Signers">
          {list.map((signer, idx) => {
            // Keyed on list POSITION, as the field placer colours by, so the two always agree.
            const color = colorForIndex(idx).css;
            return (
              <li key={signer.id} className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-primary-foreground"
                  style={{ backgroundColor: color }}
                  aria-label={`Signer ${idx + 1}`}
                >
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{resolveSignerName(signer)}</span>
                    {signer.role && (
                      <Badge variant="secondary" className="text-[10px]">
                        {SIGNER_ROLE_LABELS[signer.role] ?? signer.role}
                      </Badge>
                    )}
                    {isHigh &&
                      (signer.phone_last_four ? (
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          •••• {signer.phone_last_four}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-destructive text-[10px] text-destructive-dark">
                          No phone
                        </Badge>
                      ))}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{signer.email}</div>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => setDialog({ mode: 'edit', signer })} aria-label={`Edit ${resolveSignerName(signer)}`}>
                  <Pencil aria-hidden="true" />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setRemoveTarget(signer)} aria-label={`Remove ${resolveSignerName(signer)}`}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <SignerFormDialog
          mode={dialog.mode}
          signer={dialog.signer}
          phoneRequired={isHigh}
          nextOrder={nextSignerOrder(list)}
          existingEmails={existingEmails}
          existingContactIds={existingContactIds}
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            const action: ManageSignerAction = dialog.mode === 'edit' ? 'update' : 'add';
            const payload: SignerInput = { ...values, ...(dialog.signer ? { signer_id: dialog.signer.id } : {}) };
            // A new co-signer typed by hand links to a primary signer's contact; the server
            // then fills that contact's spouse fields instead of creating a duplicate lead.
            if (action === 'add' && payload.role === 'co_signer' && !payload.contact_id) {
              const primary = list.find((s) => s.role === 'primary') ?? list.find((s) => s.role !== 'co_signer') ?? list[0];
              if (primary?.contact_id) payload.contact_id = primary.contact_id;
            }
            await mutation.mutateAsync({ action, signer: payload });
            setDialog(null);
          }}
        />
      )}

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this signer?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget ? `${resolveSignerName(removeTarget)} leaves the envelope, with every field placed for them.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!removeTarget) return;
                // The remove branch reads only signer_id; the signer's own address satisfies the shape.
                mutation
                  .mutateAsync({ action: 'remove', signer: { signer_id: removeTarget.id, email: removeTarget.email, order: removeTarget.order } })
                  .then(() => setRemoveTarget(null))
                  .catch(() => undefined);
              }}
              disabled={mutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

interface SignerFormValues {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: SignerRole;
  order: number;
  contact_id?: string;
}

/**
 * Add or edit one signer. In add mode the owner picks a contact (or a contact's spouse, as
 * a co-signer) or types an address; leaving the address field looks it up among contacts'
 * own and spouse addresses, and links only on exactly one match. Edit mode keeps the
 * address and the contact as they are.
 */
function SignerFormDialog({
  mode,
  signer,
  phoneRequired,
  nextOrder,
  existingEmails,
  existingContactIds,
  onClose,
  onSubmit,
}: {
  mode: 'add' | 'edit';
  signer?: SignerWithContact;
  phoneRequired: boolean;
  nextOrder: number;
  existingEmails: ReadonlySet<string>;
  existingContactIds: ReadonlySet<string>;
  onClose: () => void;
  onSubmit: (values: SignerFormValues) => Promise<void>;
}) {
  // The SIGNER's own address, never the linked contact's: a co-signer carries the primary's
  // contact id and its own address, and the server writes this field back verbatim, so
  // seeding from the contact would move the co-signer's invitation to the primary's inbox.
  const [email, setEmail] = useState(signer?.email ?? '');
  // Through the one helper that owns names: on a co-signer link the names come back RAW,
  // with no fallback to the primary (an empty field is right here; the primary's name is not).
  const initialNames = signer ? resolveSignerNameParts(signer) : { first_name: null, last_name: null };
  const [firstName, setFirstName] = useState(initialNames.first_name ?? '');
  const [lastName, setLastName] = useState(initialNames.last_name ?? '');
  const [role, setRole] = useState<SignerRole | undefined>(signer?.role ?? undefined);
  const [contactId, setContactId] = useState<string | undefined>(signer?.contact_id ?? undefined);
  // Only the last four digits are known on edit; blank keeps the stored number.
  const [phone, setPhone] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [lookup, setLookup] = useState<'idle' | 'checking' | 'none' | 'matched' | 'co_signer' | 'ambiguous'>(mode === 'edit' ? 'matched' : 'idle');
  const [coSignerOf, setCoSignerOf] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(mode === 'edit' && signer?.contact ? resolveSignerName(signer) : null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts, enabled: mode === 'add', staleTime: 2 * 60_000 });
  const options = useMemo(
    () => buildSignerPickerOptions(contacts.data ?? [], existingEmails, existingContactIds).filter((o) => optionMatches(o, query)),
    [contacts.data, existingEmails, existingContactIds, query],
  );

  const pick = (o: SignerPickerOption) => {
    setContactId(o.contactId);
    setEmail(o.email);
    setFirstName(o.firstName);
    setLastName(o.lastName);
    // A co-signer pick OVERRIDES the role: the option says what this person is.
    if (o.kind === 'co_signer') setRole('co_signer');
    else setRole((r) => r ?? 'primary');
    setLookup(o.kind === 'co_signer' ? 'co_signer' : 'matched');
    setCoSignerOf(o.coSignerOf);
    setPicked(o.label);
    // Prefilled only when already in E.164; the field says so if not.
    setPhone(o.phone ?? '');
  };

  const clearPick = () => {
    setContactId(undefined);
    setEmail('');
    setFirstName('');
    setLastName('');
    setLookup('idle');
    setCoSignerOf(null);
    setPicked(null);
    setPhone('');
    setProblem(null);
  };

  const lookUpEmail = async () => {
    if (mode === 'edit' || picked) return;
    const value = email.trim().toLowerCase();
    setContactId(undefined);
    setCoSignerOf(null);
    if (!EMAIL.test(value)) {
      setLookup('idle');
      return;
    }
    setLookup('checking');
    try {
      const { byEmail, bySpouse } = await findContactsByEmail(escapeLikePattern(value));
      const ids = new Set([...byEmail, ...bySpouse].map((r) => r.id));
      // More than one contact on this address (in either column) links nothing: the server
      // refuses it too, and the owner picks the contact from the list instead.
      if (ids.size > 1) {
        setLookup('ambiguous');
        return;
      }
      if (byEmail.length === 1) {
        setContactId(byEmail[0].id);
        setFirstName(byEmail[0].first_name ?? '');
        setLastName(byEmail[0].last_name ?? '');
        setRole((r) => r ?? 'primary');
        setLookup('matched');
        return;
      }
      if (bySpouse.length === 1) {
        // A contact's spouse: link to that contact rather than creating a duplicate lead.
        const row = bySpouse[0];
        setContactId(row.id);
        setFirstName(row.spouse_first_name ?? '');
        setLastName(row.spouse_last_name ?? '');
        setRole('co_signer');
        setCoSignerOf(`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'an existing contact');
        setLookup('co_signer');
        return;
      }
      setLookup('none');
    } catch {
      // The server does the same lookup on save; a failed courtesy check links nothing.
      setLookup('none');
    }
  };

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) {
      setProblem('Enter a valid email address.');
      return;
    }
    let e164: string | undefined;
    if (phone.trim()) {
      e164 = toE164(phone);
      if (!e164) {
        setProblem('Enter the phone with its country code, for example +1 555 010 0001.');
        return;
      }
    } else if (phoneRequired && (mode === 'add' || !signer?.phone_last_four)) {
      setProblem('A phone number is required for High verification.');
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      await onSubmit({
        email: address,
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        phone: e164,
        role,
        order: signer?.order ?? nextOrder,
        contact_id: contactId,
      });
    } catch {
      // The mutation's own toast says why; the dialog stays open with what was typed.
    } finally {
      setSaving(false);
    }
  };

  const showNames = mode === 'edit' ? lookup !== 'matched' || signer?.role === 'co_signer' : lookup === 'none' || lookup === 'ambiguous';

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit signer' : 'Add signer'}</DialogTitle>
          <DialogDescription>
            {mode === 'edit' ? 'Change this signer’s details.' : 'Pick a contact, or type the signer’s email.'}
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: the dialog is a grid, so one long option would otherwise widen the form. */}
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          aria-label={mode === 'edit' ? 'Edit signer' : 'Add signer'}
        >
          {mode === 'add' && (
            <div className="flex flex-col gap-1.5">
              <Label id="esign-signer-pick-label">Pick a contact</Label>
              {picked ? (
                <div className="flex items-center gap-2 rounded-md border border-success bg-success-light px-3 py-2 text-sm text-success-dark">
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{picked}</span>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={clearPick} aria-label="Clear the chosen contact">
                    <X aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <Command className="rounded-md border border-border" shouldFilter={false} label="Search contacts">
                  <CommandInput placeholder="Search name, email or phone" value={query} onValueChange={setQuery} />
                  <CommandList className="max-h-[220px]">
                    {contacts.isPending ? (
                      <p className="px-3 py-2 text-[13px] text-muted-foreground">Loading contacts...</p>
                    ) : contacts.isError ? (
                      <p role="alert" className="px-3 py-2 text-[13px] text-destructive">
                        Could not load contacts.
                      </p>
                    ) : (
                      <>
                        <CommandEmpty>No contacts match.</CommandEmpty>
                        <CommandGroup>
                          {options.map((o) => (
                            <CommandItem key={o.optionKey} value={o.optionKey} onSelect={() => pick(o)}>
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[13px]">{o.label}</span>
                                <span className="truncate text-[11px] text-muted-foreground">{o.email || 'No email'}</span>
                              </span>
                              {o.kind === 'co_signer' && (
                                <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]">
                                  Spouse of {o.coSignerOf}
                                </Badge>
                              )}
                              {o.status && (
                                <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">
                                  {statusByKey.get(o.status)?.label ?? o.status}
                                </Badge>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                </Command>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-signer-email">Email</Label>
            <Input
              id="esign-signer-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (lookup !== 'idle') setLookup('idle');
              }}
              onBlur={() => void lookUpEmail()}
              disabled={mode === 'edit' || picked !== null}
            />
            {lookup === 'checking' && <p className="text-xs text-muted-foreground">Checking contacts...</p>}
            {lookup === 'matched' && !picked && mode === 'add' && <p className="text-xs text-success-dark">Matches an existing contact.</p>}
            {lookup === 'co_signer' && coSignerOf && (
              <p className="text-xs text-success-dark">Matches the spouse of {coSignerOf}. No new contact is created.</p>
            )}
            {lookup === 'ambiguous' && (
              <p className="text-xs text-warning-dark">More than one contact uses this email. Pick the contact from the list above.</p>
            )}
          </div>

          {showNames && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="esign-signer-first">First name</Label>
                <Input id="esign-signer-first" value={firstName} maxLength={100} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="esign-signer-last">Last name</Label>
                <Input id="esign-signer-last" value={lastName} maxLength={100} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>
          )}

          {phoneRequired && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="esign-signer-phone">Mobile phone</Label>
              <Input
                id="esign-signer-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder={signer?.phone_last_four ? `•••• ${signer.phone_last_four}` : '+1 555 010 0001'}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                With the country code. The signing code is texted here.
                {mode === 'edit' && signer?.phone_last_four ? ' Leave it blank to keep the current number.' : ''}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-signer-role">Role</Label>
            <Select value={role ?? ''} onValueChange={(v) => setRole(v as SignerRole)}>
              <SelectTrigger id="esign-signer-role">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {SIGNER_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {SIGNER_ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : mode === 'edit' ? 'Save changes' : 'Add signer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
