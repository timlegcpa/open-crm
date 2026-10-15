import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from '@/components/ui/sonner';
import { links } from '@/features/links';
import { getDocument } from '@/features/documents/api';
import { useContactCandidates } from '@/hooks/useContactCandidates';
import { getErrorMessage } from '@/lib/errors';
import { splitFilename } from '@/lib/format';
import { createEnvelope, getEsignSettings, importStoredDocument } from '../api';
import { TITLE_MAX, type VerificationLevel } from '../contract';
import { esignKeys } from '../keys';

const NONE = '__none__';

/** Control characters are stripped by the server too; doing it here keeps the counter honest. */
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Start a draft: a title, how signers prove who they are, and (optionally) the contact it
 * is for. Opened from a contact (`?contact=`) that contact is preselected; opened from a
 * stored document (`?document=`) the title, the contact and the first source PDF come
 * from that document. The composer opens on the new envelope.
 */
export function NewEnvelopeForm({ contactId, documentId }: { contactId: string | null; documentId: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState<VerificationLevel>('standard');
  const [primaryContactId, setPrimaryContactId] = useState<string | null>(contactId);
  const [submitting, setSubmitting] = useState(false);

  const settings = useQuery({ queryKey: esignKeys.settings, queryFn: getEsignSettings });
  const smsOff = settings.data?.sms_enabled === false;

  const sourceDoc = useQuery({
    queryKey: ['client-documents', 'one', documentId ?? ''],
    queryFn: () => getDocument(documentId!),
    enabled: documentId !== null,
  });

  // A document prefills what is still empty, once it arrives.
  const prefilled = useRef(false);
  useEffect(() => {
    const doc = sourceDoc.data;
    if (!doc || prefilled.current) return;
    prefilled.current = true;
    setTitle((t) => t || splitFilename(doc.original_filename).name.slice(0, TITLE_MAX));
    setPrimaryContactId((c) => c ?? doc.contact_id);
  }, [sourceDoc.data]);

  // The contacts list's own search rule, not cmdk's fuzzy matcher: only real matches.
  const [query, setQuery] = useState('');
  const { contacts, candidates } = useContactCandidates(query, true);
  const { candidates: everyone } = useContactCandidates('', true);
  const selected = useMemo(
    () => (primaryContactId ? everyone.find((c) => c.id === primaryContactId) ?? null : null),
    [everyone, primaryContactId],
  );

  // A new search starts at the top of its results with the first match highlighted. cmdk
  // keeps its highlight when it is not filtering, and scrolls to wherever that sits.
  const [active, setActive] = useState(NONE);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setActive(query.trim() ? (candidates[0]?.id ?? '') : NONE);
    const frame = requestAnimationFrame(() => listRef.current?.scrollTo?.({ top: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [query, candidates]);

  const cleanTitle = title.replace(CONTROL, '').trim();
  const titleOk = cleanTitle.length >= 1 && cleanTitle.length <= TITLE_MAX;
  const documentMissing = documentId !== null && sourceDoc.isSuccess && sourceDoc.data === null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!titleOk || submitting) return;
    setSubmitting(true);
    let envelopeId: string;
    try {
      const created = await createEnvelope({ title: cleanTitle, verification_level: level, primary_contact_id: primaryContactId });
      envelopeId = created.id;
    } catch (err) {
      toast.error(getErrorMessage(err, 'The envelope was not created. Try again.'));
      setSubmitting(false);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: esignKeys.envelopes });
    if (documentId && sourceDoc.data) {
      try {
        await importStoredDocument(envelopeId, documentId);
      } catch (err) {
        // The draft exists either way; the owner adds the PDF in the composer.
        toast.error(`The envelope was created, but the document was not added: ${getErrorMessage(err)} Add it in the composer.`);
      }
    }
    navigate(links.envelope(envelopeId));
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex max-w-xl flex-col gap-5" aria-label="New envelope">
      {documentId !== null && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          {sourceDoc.isPending
            ? 'Loading the document...'
            : documentMissing
              ? 'That document could not be found. You can still start an envelope and add a PDF in the composer.'
              : sourceDoc.data
                ? `Starts with ${sourceDoc.data.original_filename}.`
                : `Could not load the document: ${getErrorMessage(sourceDoc.error)}`}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="esign-title">Title</Label>
        <Input
          id="esign-title"
          placeholder="e.g. Engagement letter, Acme LLC"
          maxLength={TITLE_MAX}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">Signers see this title in their email and on the signing page.</p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Verification</legend>
        <RadioGroup
          value={level}
          onValueChange={(v) => setLevel(v as VerificationLevel)}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          aria-label="Verification"
        >
          {[
            { value: 'standard', title: 'Standard', hint: 'A link by email, then click to sign.' },
            { value: 'high', title: 'High', hint: 'Signers also confirm a code sent to their phone.' },
          ].map((opt) => {
            const disabled = opt.value === 'high' && smsOff;
            return (
              <Label
                key={opt.value}
                htmlFor={`esign-verification-${opt.value}`}
                className="flex cursor-pointer flex-col items-start gap-1 rounded-md border border-border p-3 text-left hover:bg-muted has-[:checked]:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <span className="flex items-center gap-2">
                  <RadioGroupItem value={opt.value} id={`esign-verification-${opt.value}`} disabled={disabled} />
                  <span className="text-sm font-medium">{opt.title}</span>
                </span>
                <span className="text-xs font-normal text-muted-foreground">{opt.hint}</span>
              </Label>
            );
          })}
        </RadioGroup>
        {smsOff ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              SMS codes are turned off.{' '}
              <Link to={links.settingsSection('esign')} className="text-link underline-offset-4 hover:underline">
                Turn them on in Settings
              </Link>{' '}
              to use High.
            </span>
          </p>
        ) : (
          level === 'high' && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>Each signer needs a mobile number, entered with its country code.</span>
            </p>
          )
        )}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label id="esign-contact-label">Contact (optional)</Label>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {selected ? (
            <>
              Chosen: <span className="text-foreground">{selected.name}</span>
            </>
          ) : (
            'No contact chosen.'
          )}
        </p>
        <Command
          className="rounded-md border border-border"
          shouldFilter={false}
          value={active}
          onValueChange={setActive}
          label="Search contacts"
        >
          <CommandInput
            placeholder="Search name, email, phone or business"
            value={query}
            onValueChange={(next) => {
              // Drop the old highlight in the same keystroke, or cmdk scrolls it back
              // into view after the jump to the top.
              setActive('');
              setQuery(next);
            }}
          />
          <CommandList ref={listRef} className="max-h-[240px]">
            {contacts.isSuccess && <CommandEmpty>No contacts match.</CommandEmpty>}
            <CommandGroup>
              {/* None stays choosable while the list loads and whenever the search is empty. */}
              {!query.trim() && (
                <CommandItem value={NONE} onSelect={() => setPrimaryContactId(null)}>
                  <span className="text-muted-foreground">None</span>
                  {!primaryContactId && <Check className="ml-auto size-4" aria-label="chosen" />}
                </CommandItem>
              )}
              {contacts.isPending ? (
                <p className="px-3 py-2 text-[13px] text-muted-foreground">Loading contacts...</p>
              ) : contacts.isError ? (
                <p role="alert" className="px-3 py-2 text-[13px] text-destructive">
                  Could not load contacts.
                </p>
              ) : (
                candidates.map((c) => (
                  <CommandItem key={c.id} value={c.id} onSelect={() => setPrimaryContactId(c.id)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px]">{c.name}</span>
                      {c.detail && <span className="truncate text-[11px] text-muted-foreground">{c.detail}</span>}
                    </span>
                    {primaryContactId === c.id && <Check className="ml-auto size-4" aria-label="chosen" />}
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!titleOk || submitting}>
          {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          Create envelope
        </Button>
        <Button type="button" variant="ghost" onClick={() => navigate(links.esign())} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
