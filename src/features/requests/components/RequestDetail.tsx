import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, FileText, Lock } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { ToneBadge, type ToneBadgeVariant } from '@/components/ui/tone-badge';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { acceptAll, acceptItem, closeRequest, deleteRequest, remindRequest, revealAnswer, setRemindersPaused } from '../api';
import { requestKeys } from '../keys';
import {
  canAccept,
  isActionable,
  isItemFulfilled,
  ITEM_STATUS_LABELS,
  LIST_STATUS_LABELS,
  listProgress,
  type ItemStatus,
  type RequestItem,
  type RequestList,
  type RequestWithItems,
} from '../lib/requests';
import { KIND_ICONS } from './RequestPreview';
import { LIST_TONES } from './RequestRow';

const ITEM_TONES: Record<ItemStatus, ToneBadgeVariant> = { pending: 'default', fulfilled: 'warning', reviewed: 'success' };

/** A sent, submitted or closed request, for the owner: every item, its answer, and what to do next. */
export function RequestDetail({ request }: { request: RequestWithItems }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: requestKeys.all });
  const progress = listProgress(request.items);
  const open = request.status === 'sent' || request.status === 'submitted';

  const run = (fn: () => Promise<unknown>, done: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(done);
      void refresh();
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'That did not save. Try again.'));
      void refresh();
    },
  });
  const remind = useMutation({
    mutationFn: () => remindRequest(request.id),
    onSuccess: (r) => {
      toast.success(r.email_sent === null ? 'Reminder sent; the email may not have gone out.' : `Reminder sent: ${r.remaining} ${r.remaining === 1 ? 'item' : 'items'} open.`);
      void refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The reminder was not sent.')),
  });
  const pause = useMutation(run(() => setRemindersPaused(request.id, !request.reminders_paused), request.reminders_paused ? 'Reminders resumed.' : 'Reminders paused.'));
  const acceptEvery = useMutation({
    mutationFn: () => acceptAll(request.id),
    onSuccess: (n) => {
      toast.success(n === 0 ? 'Nothing was waiting to accept.' : `Accepted ${n} ${n === 1 ? 'item' : 'items'}.`);
      void refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const close = useMutation(run(() => closeRequest(request.id), 'Request closed.'));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Request"
        action={<ToneBadge variant={LIST_TONES[request.status]}>{LIST_STATUS_LABELS[request.status]}</ToneBadge>}
        bodyClassName="flex flex-col gap-3 p-4"
      >
        <div className="flex flex-col gap-1">
          <h2 className="break-words text-[15px] font-semibold">{request.title}</h2>
          {request.intro_message && <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{request.intro_message}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
          <Fact label="Sent">{request.sent_at ? formatDate(request.sent_at) : 'Not sent'}</Fact>
          <Fact label="Answered">{`${progress.fulfilled} of ${progress.actionable}`}</Fact>
          <Fact label="Reminders">{request.reminders_paused ? `${request.reminder_count}, paused` : String(request.reminder_count)}</Fact>
          <Fact label={request.status === 'closed' ? 'Closed' : 'Submitted'}>
            {request.status === 'closed' ? formatDate(request.closed_at) : request.submitted_at ? formatDate(request.submitted_at) : 'Not yet'}
          </Fact>
        </dl>
        <div className="flex flex-wrap gap-2">
          {request.status === 'sent' && (
            <>
              <Button size="sm" variant="outline" onClick={() => remind.mutate()} disabled={remind.isPending || progress.actionable === progress.fulfilled}>
                Remind now
              </Button>
              <Button size="sm" variant="outline" onClick={() => pause.mutate()} disabled={pause.isPending}>
                {request.reminders_paused ? 'Resume reminders' : 'Pause reminders'}
              </Button>
            </>
          )}
          {open && progress.awaitingAccept > 0 && (
            <Button size="sm" variant="outline" onClick={() => acceptEvery.mutate()} disabled={acceptEvery.isPending}>
              <Check aria-hidden /> Accept all answered ({progress.awaitingAccept})
            </Button>
          )}
          {open && (
            <Button size="sm" variant="outline" onClick={() => close.mutate()} disabled={close.isPending}>
              Close request
            </Button>
          )}
          <DeleteRequestButton request={request} />
        </div>
      </Panel>

      <Panel title={`Items (${request.items.length})`} bodyClassName="divide-y divide-border">
        {request.items.map((item) => (
          // Keyed on the stored answer too: when the client changes a sensitive answer, the
          // old one, if revealed, is put away rather than shown as the current one.
          <ItemRow key={`${item.id}:${item.secret_answer_key ?? 'none'}`} item={item} listOpen={open} onChanged={refresh} />
        ))}
      </Panel>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ItemRow({ item, listOpen, onChanged }: { item: RequestItem; listOpen: boolean; onChanged: () => void }) {
  const Icon = KIND_ICONS[item.kind];
  const [revealed, setRevealed] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: () => acceptItem(item.id),
    onSuccess: () => {
      toast.success('Accepted.');
      onChanged();
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
      onChanged();
    },
  });
  const reveal = useMutation({
    mutationFn: () => revealAnswer(item.id),
    onSuccess: setRevealed,
    onError: (err) => toast.error(getErrorMessage(err, 'The answer could not be shown.')),
  });
  const done = isItemFulfilled(item);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
      <Icon className="mt-0.5 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="break-words text-[14px] font-medium">
          {item.label}
          {isActionable(item) && !item.required && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">(optional)</span>}
        </p>
        {item.description && <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{item.description}</p>}
        <div className="mt-1.5 text-[13px]">
          {item.kind === 'question' && !item.sensitive && (item.answer_text ? <p className="whitespace-pre-wrap break-words">{item.answer_text}</p> : <NoAnswer />)}
          {item.kind === 'question' && item.sensitive && (
            <div className="flex flex-wrap items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              {!item.has_secret_answer && <NoAnswer />}
              {item.has_secret_answer && revealed === null && (
                <Button size="xs" variant="outline" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
                  <Eye aria-hidden /> Reveal answer
                </Button>
              )}
              {revealed !== null && (
                <span className="break-all font-mono">
                  {revealed}{' '}
                  <button type="button" className="ml-1 text-[12px] text-muted-foreground underline" onClick={() => setRevealed(null)}>
                    Hide
                  </button>
                </span>
              )}
            </div>
          )}
          {item.kind === 'document' &&
            (item.documents.length === 0 ? (
              <NoAnswer />
            ) : (
              <ul className="flex flex-col gap-0.5">
                {item.documents.map((d) => (
                  <li key={d.id} className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <Link to={links.document(d.document_id)} className="break-all underline-offset-2 hover:underline">
                      {d.original_filename ?? 'Uploaded file'}
                    </Link>
                    <span className="text-[12px] text-muted-foreground">{formatDateTime(d.uploaded_at)}</span>
                  </li>
                ))}
              </ul>
            ))}
          {item.kind === 'todo' && <p className="text-muted-foreground">{done ? 'Marked done by the client.' : 'Not done yet.'}</p>}
        </div>
      </div>
      {isActionable(item) && (
        <div className="flex shrink-0 items-center gap-2">
          <ToneBadge variant={ITEM_TONES[item.status]}>{ITEM_STATUS_LABELS[item.status]}</ToneBadge>
          {listOpen && canAccept(item) && (
            <Button size="xs" variant="outline" onClick={() => accept.mutate()} disabled={accept.isPending} aria-label={`Accept ${item.label}`}>
              Accept
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const NoAnswer = () => <p className="text-muted-foreground">No answer yet.</p>;

/** Delete, with the choice to remove the client's uploaded files too (on by default once sent). */
export function DeleteRequestButton({ request }: { request: RequestList & { items?: RequestItem[] } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const hasFiles = request.status !== 'draft';
  const [deleteFiles, setDeleteFiles] = useState(hasFiles);
  const remove = useMutation({
    mutationFn: () => deleteRequest(request, { deleteFiles: hasFiles && deleteFiles }),
    onSuccess: (r) => {
      toast[r.cleanupOk ? 'success' : 'warning'](
        r.cleanupOk ? 'Request deleted.' : 'Request deleted, but some of its files could not be removed. Check the documents.',
      );
      queryClient.removeQueries({ queryKey: requestKeys.detail(request.id) });
      void queryClient.invalidateQueries({ queryKey: requestKeys.all });
      navigate(links.contactTab(request.contact_id, 'requests'), { replace: true });
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The request was not deleted.')),
  });
  return (
    <>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasFiles
                ? 'The request and every answer in it are deleted. The client no longer sees it.'
                : 'The draft is deleted. It was never sent.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasFiles && (
            <div className="flex items-start gap-2">
              <Checkbox id="delete-files" checked={deleteFiles} onCheckedChange={(v) => setDeleteFiles(v === true)} />
              <Label htmlFor="delete-files" className="font-normal leading-snug">
                Also delete the files the client uploaded to it
              </Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                remove.mutate();
              }}
              disabled={remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
