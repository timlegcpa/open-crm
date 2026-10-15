import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { contactDisplayName, isUuid, listContacts } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { ContactPicker } from '@/components/contacts/ContactPicker';
import { PAGE, PageHeader, Panel } from '@/components/layout/page';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { emailKeys, previewGroupEmail, sendGroupEmail, type GroupEmailPreview, type GroupEmailSendResult } from './api';
import { idsFromQuery, MAX_RECIPIENTS, sendErrorMessage, splitRecipients, TYPED_CONFIRM_THRESHOLD } from './compose';
import { deliveryNote, describeSendResult } from './result';

/**
 * Compose one message and send each chosen contact its own copy. Recipients arrive in the
 * link (links.newGroupEmail) and can be added or removed here.
 *
 * ONE request id per composition, resent unchanged on every attempt: the server keeps it
 * unique, so a double-click or a retry after a lost answer returns the first campaign
 * instead of mailing everyone again. It is never regenerated per attempt, and it rotates
 * whenever the composition changes (subject, body or recipients) and after a send, so a
 * key never describes a message it was not minted for: an edit after a lost answer would
 * otherwise be treated as a replay and silently dropped.
 */
export function NewGroupEmailPage() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts });
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);

  const [ids, setIds] = useState<string[]>(() => idsFromQuery(params.get('to'), isUuid));
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [stage, setStage] = useState<'compose' | 'review'>('compose');
  const [confirmText, setConfirmText] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GroupEmailSendResult | null>(null);
  const [preview, setPreview] = useState<GroupEmailPreview | null>(null);
  /**
   * Which preview the page will still show. A render is a round trip, and in that time
   * the owner can go back and rewrite the message; the late answer describes the OLD
   * draft, and must not open as if it were the current one. Every discard bumps this.
   */
  const previewSeq = useRef(0);

  const rotate = () => setIdempotencyKey(crypto.randomUUID());
  const clearPreview = () => {
    previewSeq.current += 1;
    setPreview(null);
  };

  const byId = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, c])), [contacts.data]);
  const chosen = useMemo(() => ids.map((id) => byId.get(id)).filter((c) => c !== undefined), [ids, byId]);
  const { eligible, skipped } = useMemo(
    () => splitRecipients(chosen, (key) => statusByKey.get(key)?.label ?? key),
    [chosen, statusByKey],
  );
  const composition = { subject, body, contactIds: eligible.map((c) => c.id) };
  const needsTypedConfirm = eligible.length >= TYPED_CONFIRM_THRESHOLD;
  const confirmed = !needsTypedConfirm || confirmText.trim() === String(eligible.length);
  const canReview = subject.trim() !== '' && body.trim() !== '' && eligible.length > 0 && eligible.length <= MAX_RECIPIENTS;

  const edit = (apply: () => void) => {
    apply();
    rotate();
    clearPreview();
    setError(null);
  };
  const addRecipient = (id: string) => {
    if (!ids.includes(id)) edit(() => setIds((prev) => [...prev, id]));
  };
  const removeRecipient = (id: string) => edit(() => setIds((prev) => prev.filter((x) => x !== id)));

  const send = useMutation({ mutationFn: () => sendGroupEmail(composition, idempotencyKey) });
  const previewMutation = useMutation({ mutationFn: previewGroupEmail });

  async function onSend() {
    setError(null);
    try {
      const answer = await send.mutateAsync();
      const words = describeSendResult(answer);
      if (words.incomplete) toast.error(words.title);
      else toast.success(words.title);
      void queryClient.invalidateQueries({ queryKey: emailKeys.all });
      setResult(answer);
      // A finished send ends the composition.
      setSubject('');
      setBody('');
      setIds([]);
      setConfirmText('');
      setStage('compose');
      rotate();
      clearPreview();
    } catch (err) {
      // The same composition, unchanged, keeps its key: retrying is safe.
      setError(sendErrorMessage(err));
      toast.error('The email was not sent.');
    }
  }

  async function onPreview() {
    const seq = (previewSeq.current += 1);
    setError(null);
    try {
      const answer = await previewMutation.mutateAsync(composition);
      if (seq === previewSeq.current) setPreview(answer);
    } catch (err) {
      // A failure of a preview already discarded is about a draft no longer on screen.
      if (seq === previewSeq.current) setError(sendErrorMessage(err));
    }
  }

  const resultWords = result ? describeSendResult(result) : null;

  return (
    <>
      <PageHeader title="New group email" subtitle="One message, sent to each person separately" />
      <div className={`${PAGE} flex flex-col gap-4`}>
        {resultWords && result && (
          <Alert variant={resultWords.incomplete ? 'destructive' : 'default'}>
            <AlertTitle>{resultWords.title}</AlertTitle>
            <AlertDescription>
              <p>{resultWords.description}</p>
              <Link className="text-sm underline" to={`/email/${encodeURIComponent(result.campaign_id)}`}>
                See how each one landed
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {stage === 'compose' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="group-email-subject">Subject</Label>
                <Input
                  id="group-email-subject"
                  value={subject}
                  maxLength={200}
                  placeholder="A quick update"
                  onChange={(e) => edit(() => setSubject(e.target.value))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="group-email-body">Message</Label>
                <Textarea
                  id="group-email-body"
                  value={body}
                  rows={12}
                  maxLength={50000}
                  placeholder={'Hi {{first_name}},\n\n...'}
                  onChange={(e) => edit(() => setBody(e.target.value))}
                />
                <p className="text-[12px] text-muted-foreground">
                  {'{{first_name}}'} becomes each recipient&apos;s first name. An unsubscribe link is added to every
                  email, and it cannot be removed.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!canReview} onClick={() => { setError(null); setStage('review'); }}>
                  Review {eligible.length} {eligible.length === 1 ? 'recipient' : 'recipients'}
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/email">Cancel</Link>
                </Button>
              </div>
            </div>

            <Panel
              title={`Recipients (${eligible.length})`}
              action={
                <ContactPicker grouped onSelect={(c) => addRecipient(c.id)}>
                  <Button size="xs" variant="ghost" aria-label="Add a recipient">
                    <Plus aria-hidden="true" />Add
                  </Button>
                </ContactPicker>
              }
            >
              {contacts.isPending ? (
                <p className="px-3.5 py-3 text-[13px] text-muted-foreground">Loading contacts...</p>
              ) : contacts.isError ? (
                <p role="alert" className="px-3.5 py-3 text-[13px] text-destructive">Could not load contacts.</p>
              ) : chosen.length === 0 ? (
                <p className="px-3.5 py-3 text-[13px] text-muted-foreground">Add the contacts to email.</p>
              ) : (
                <ScrollArea className="max-h-[420px]" fitWidth>
                  <ul className="divide-y divide-border">
                    {chosen.map((c) => {
                      const skip = skipped.find((s) => s.contact.id === c.id);
                      return (
                        <li key={c.id} className="flex items-center gap-2 px-3.5 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px]">{contactDisplayName(c)}</p>
                            <p className={`truncate text-[12px] ${skip ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {skip ? `Skipped: ${skip.why}` : c.email}
                            </p>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label={`Remove ${contactDisplayName(c)}`}
                            onClick={() => removeRecipient(c.id)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </ScrollArea>
              )}
              {eligible.length > MAX_RECIPIENTS && (
                <p role="alert" className="border-t border-border px-3.5 py-2 text-[12px] text-destructive">
                  A group email goes to at most {MAX_RECIPIENTS} people.
                </p>
              )}
            </Panel>
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-4">
            <Alert>
              <AlertDescription>
                Sending <strong>{eligible.length}</strong> separate {eligible.length === 1 ? 'email' : 'emails'} as{' '}
                <strong>&ldquo;{subject.trim()}&rdquo;</strong>. Anyone who has unsubscribed is left out by the server,
                even if they are listed here. A sent email cannot be recalled.
              </AlertDescription>
            </Alert>
            <Panel title="Sending to">
              <ScrollArea className="max-h-64" fitWidth>
                <ul className="divide-y divide-border">
                  {eligible.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 px-3.5 py-1.5 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{contactDisplayName(c)}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{c.email}</span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </Panel>
            {needsTypedConfirm && (
              <div className="flex max-w-xs flex-col gap-1.5">
                <Label htmlFor="group-email-confirm">Type {eligible.length} to confirm</Label>
                <Input
                  id="group-email-confirm"
                  value={confirmText}
                  autoComplete="off"
                  inputMode="numeric"
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={send.isPending}
                onClick={() => {
                  clearPreview();
                  setStage('compose');
                }}
              >
                Back
              </Button>
              <Button variant="outline" disabled={previewMutation.isPending || send.isPending} onClick={() => void onPreview()}>
                <Eye aria-hidden="true" />
                {previewMutation.isPending ? 'Rendering...' : 'Preview'}
              </Button>
              <Button disabled={!confirmed || send.isPending} onClick={() => void onSend()}>
                {send.isPending ? 'Sending...' : `Send ${eligible.length}`}
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) clearPreview(); }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Email preview</DialogTitle>
            <DialogDescription>
              {preview &&
                `As ${preview.sample.first_name || 'this recipient'} will see it (${preview.sample.address}). Each recipient gets their own name.`}
            </DialogDescription>
          </DialogHeader>
          {preview && deliveryNote(preview.delivery) && (
            <p className="text-[12px] text-destructive">{deliveryNote(preview.delivery)}</p>
          )}
          {/* Sandboxed: the email's markup and links cannot reach this page. A light-scheme
              document, as every mail client paints it. */}
          <iframe
            title="Group email preview"
            srcDoc={preview?.html ?? ''}
            sandbox=""
            className="h-[55vh] w-full rounded-md border border-border"
            style={{ colorScheme: 'light' }}
          />
          <p className="text-[12px] text-muted-foreground">
            The unsubscribe link is made for each recipient when the email sends.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
