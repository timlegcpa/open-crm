import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Loader2, Lock, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { links } from '@/features/links';
import { getMyContact, portalKeys } from '@/features/portal/api';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { requestKeys } from './keys';
import { isActionable, isItemFulfilled, LIMITS, listProgress, openRequestLists, type RequestItem, type RequestWithItems } from './lib/requests';
import {
  CONFIRM_FIELDS,
  ensureRequestFolder,
  getMyRequest,
  listMyRequests,
  markItem,
  saveAnswer,
  saveContactDetails,
  submitRequest,
  subscribeToMyRequests,
  uploadToItem,
  type ConfirmField,
} from './portalApi';
import { KIND_ICONS } from './components/RequestPreview';

/** How long typing pauses before an answer saves on its own. */
export const AUTOSAVE_MS = 700;
const READ_ONLY_TITLE = 'Read-only while viewing as client';

function useLiveRequests(contactId: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!contactId) return;
    return subscribeToMyRequests(contactId, () => {
      void queryClient.invalidateQueries({ queryKey: requestKeys.mine(contactId) });
    });
  }, [contactId, queryClient]);
}

/** The portal Home card: the requests waiting on the client. */
export function RequestsCard() {
  const { clientContactId } = useAuth();
  const requests = useQuery({
    queryKey: requestKeys.mine(clientContactId ?? ''),
    queryFn: () => listMyRequests(clientContactId!),
    enabled: !!clientContactId,
  });
  useLiveRequests(clientContactId ?? null);
  const open = openRequestLists(requests.data ?? []);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[14px] font-semibold">Requests</h2>
      {requests.isPending && clientContactId && <Skeleton className="h-10 w-full" />}
      {requests.error && (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load your requests: {getErrorMessage(requests.error)}
        </p>
      )}
      {requests.isSuccess && open.length === 0 && <p className="text-[13px] text-muted-foreground">No open requests.</p>}
      {open.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {open.map((r) => {
            const p = listProgress(r.items);
            return (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link to={links.portalRequest(r.id)} className="break-words font-medium underline-offset-2 hover:underline">
                    {r.title}
                  </Link>
                  <p className="text-[12px] text-muted-foreground">{`${p.fulfilled} of ${p.actionable} done`}</p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link to={links.portalRequest(r.id)}>Open</Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** /portal/requests/:id: the items asked of the client, answered one at a time. */
export function PortalRequestPage() {
  const { id } = useParams();
  const { clientContactId, isViewAsClientSession: viewing } = useAuth();
  const queryClient = useQueryClient();
  const request = useQuery({ queryKey: requestKeys.myRequest(id ?? ''), queryFn: () => getMyRequest(id!), enabled: !!id });
  // A change on the client's lists (this one closed, another sent) refreshes the page.
  useEffect(() => {
    if (!clientContactId || !id) return;
    return subscribeToMyRequests(clientContactId, () => {
      void queryClient.invalidateQueries({ queryKey: requestKeys.myRequest(id) });
      void queryClient.invalidateQueries({ queryKey: requestKeys.mine(clientContactId) });
    });
  }, [clientContactId, id, queryClient]);

  if (request.isPending) return <Skeleton className="h-40 w-full" />;
  if (request.error)
    return (
      <p role="alert" className="text-[13px] text-destructive">
        Could not load this request: {getErrorMessage(request.error)}
      </p>
    );
  if (!request.data || !clientContactId)
    return (
      <div className="flex flex-col gap-2 text-[14px]">
        <p>This request is not available.</p>
        <Link to={links.portalHome()} className="underline underline-offset-2">
          Back to home
        </Link>
      </div>
    );
  return <RequestForm request={request.data} contactId={clientContactId} readOnly={viewing} />;
}

function RequestForm({ request, contactId, readOnly }: { request: RequestWithItems; contactId: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const open = request.status === 'sent';
  const editable = open && !readOnly;
  const [inFlight, setInFlight] = useState(0);
  const track = async <T,>(work: Promise<T>): Promise<T> => {
    setInFlight((n) => n + 1);
    try {
      return await work;
    } finally {
      setInFlight((n) => n - 1);
    }
  };
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: requestKeys.myRequest(request.id) }),
      queryClient.invalidateQueries({ queryKey: requestKeys.mine(contactId) }),
    ]);

  // The list's folder is made once per page, however many files are uploaded.
  const folder = useRef<Promise<void> | null>(null);
  const ensureListFolder = () => {
    folder.current ??= ensureRequestFolder(contactId, request).catch((err) => {
      folder.current = null;
      throw err;
    });
    return folder.current;
  };

  const progress = listProgress(request.items);
  const submit = useMutation({
    mutationFn: () => submitRequest(request.id),
    onSuccess: (status) => {
      toast.success(status === 'already_submitted' ? 'This request was already submitted.' : 'Submitted. Thank you.');
      void refresh();
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'The request was not submitted. Try again.'));
      void refresh();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="break-words text-xl font-semibold">{request.title}</h1>
        {request.sent_at && <p className="text-[12px] text-muted-foreground">Sent {formatDate(request.sent_at)}</p>}
        {request.intro_message && <p className="whitespace-pre-wrap break-words text-[14px] text-muted-foreground">{request.intro_message}</p>}
      </header>
      {request.status === 'submitted' && <Notice>You submitted this request. It is with us now; we will be in touch if anything else is needed.</Notice>}
      {request.status === 'closed' && <Notice>This request is closed. Nothing more is needed.</Notice>}
      {readOnly && open && <Notice>You are viewing as the client. Nothing here can be changed.</Notice>}

      {request.include_contact_confirm && open && <ConfirmDetails listId={request.id} editable={editable} track={track} />}

      <ol className="flex flex-col gap-3">
        {request.items.map((item) => (
          <li key={item.id} className="rounded-lg border border-border bg-card p-4">
            <ItemField
              item={item}
              editable={editable && item.status !== 'reviewed'}
              track={track}
              onSaved={refresh}
              upload={(file) =>
                track(uploadToItem({ file, contactId, list: request, itemId: item.id, category: item.category, ensureListFolder }))
              }
            />
          </li>
        ))}
      </ol>

      {open && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <p className="text-[13px]" aria-live="polite">
            {inFlight > 0
              ? 'Saving...'
              : progress.canSubmit
                ? `${progress.fulfilled} of ${progress.actionable} done. Ready to submit.`
                : `${progress.requiredOpen} required ${progress.requiredOpen === 1 ? 'item is' : 'items are'} still open.`}
          </p>
          <div>
            <Button
              onClick={() => submit.mutate()}
              disabled={!editable || !progress.canSubmit || inFlight > 0 || submit.isPending}
              title={readOnly ? READ_ONLY_TITLE : undefined}
            >
              {submit.isPending ? 'Submitting...' : 'Submit'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const Notice = ({ children }: { children: string }) => (
  <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-[13px]" role="status">
    {children}
  </p>
);

type Track = <T>(work: Promise<T>) => Promise<T>;

function ItemField({
  item,
  editable,
  track,
  onSaved,
  upload,
}: {
  item: RequestItem;
  editable: boolean;
  track: Track;
  onSaved: () => Promise<unknown>;
  upload: (file: File) => Promise<string>;
}) {
  const Icon = KIND_ICONS[item.kind];
  const done = isItemFulfilled(item);
  const fieldId = `item-${item.id}`;
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="break-words text-[14px] font-medium" id={`${fieldId}-label`}>
            {item.label}
            {isActionable(item) && !item.required && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">(optional)</span>}
          </p>
          {item.description && <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{item.description}</p>}
        </div>
        {item.status === 'reviewed' && (
          <p className="flex items-center gap-1 text-[12px] text-success-dark">
            <Check className="h-3.5 w-3.5" aria-hidden /> Accepted
          </p>
        )}
        {item.kind === 'question' && <QuestionField item={item} editable={editable} track={track} onSaved={onSaved} labelId={`${fieldId}-label`} />}
        {item.kind === 'todo' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={fieldId}
              checked={done}
              disabled={!editable}
              onCheckedChange={(v) => {
                void track(markItem(item.id, v === true))
                  .then(onSaved)
                  .catch((err) => toast.error(getErrorMessage(err, 'That did not save. Try again.')));
              }}
            />
            <Label htmlFor={fieldId} className="font-normal">
              Done
            </Label>
          </div>
        )}
        {item.kind === 'document' && <DocumentField item={item} editable={editable} upload={upload} onSaved={onSaved} labelId={`${fieldId}-label`} />}
      </div>
    </div>
  );
}

function QuestionField({
  item,
  editable,
  track,
  onSaved,
  labelId,
}: {
  item: RequestItem;
  editable: boolean;
  track: Track;
  onSaved: () => Promise<unknown>;
  labelId: string;
}) {
  // A sensitive answer is never shown back (it is stored encrypted); its box starts empty.
  const [text, setText] = useState(item.sensitive ? '' : item.answer_text ?? '');
  const saved = useRef(item.sensitive ? '' : item.answer_text ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const flush = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!editable || value === saved.current) return;
    // A sensitive box never shows the stored answer, so a blank one (spaces included) means
    // "nothing typed yet", never "erase my answer": the server would clear it.
    if (item.sensitive && value.trim() === '') return;
    setState('saving');
    void track(saveAnswer(item.id, value))
      .then(() => {
        saved.current = value;
        setState('saved');
        if (item.sensitive) {
          setText('');
          saved.current = '';
        }
        return onSaved();
      })
      .catch((err) => {
        setState('error');
        toast.error(getErrorMessage(err, 'Your answer did not save. Try again.'));
      });
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(value), AUTOSAVE_MS);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {item.sensitive && (
        <p className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden />
          {item.has_secret_answer ? 'Your answer is saved securely. Type here to replace it.' : 'Your answer is stored encrypted.'}
        </p>
      )}
      <Textarea
        aria-labelledby={labelId}
        value={text}
        rows={item.sensitive ? 1 : 3}
        maxLength={LIMITS.answer}
        disabled={!editable}
        onChange={onChange}
        onBlur={() => flush(text)}
        autoComplete={item.sensitive ? 'off' : undefined}
      />
      <p className="h-4 text-[12px] text-muted-foreground" aria-live="polite">
        {state === 'saving' ? 'Saving...' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ''}
      </p>
    </div>
  );
}

function DocumentField({
  item,
  editable,
  upload,
  onSaved,
  labelId,
}: {
  item: RequestItem;
  editable: boolean;
  upload: (file: File) => Promise<string>;
  onSaved: () => Promise<unknown>;
  labelId: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const onFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (input.current) input.current.value = '';
    for (const file of list) {
      setUploading((n) => n + 1);
      try {
        await upload(file);
        toast.success(`Uploaded ${file.name}.`);
      } catch (err) {
        toast.error(getErrorMessage(err, `${file.name} did not upload. Try again.`));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    await onSaved();
  };
  const files = useMemo(() => item.documents, [item.documents]);
  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {files.map((d) => (
            <li key={d.id} className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="break-all">{d.original_filename ?? 'Uploaded file'}</span>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div>
          <input
            ref={input}
            type="file"
            multiple
            className="sr-only"
            aria-labelledby={labelId}
            onChange={(e) => void onFiles(e.target.files)}
            tabIndex={-1}
          />
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={uploading > 0}>
            {uploading > 0 ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
            {uploading > 0 ? 'Uploading...' : files.length > 0 ? 'Upload another file' : 'Upload a file'}
          </Button>
        </div>
      )}
    </div>
  );
}

const FIELD_LABELS: Record<ConfirmField, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  business_name: 'Business name',
};

function ConfirmDetails({ listId, editable, track }: { listId: string; editable: boolean; track: Track }) {
  const queryClient = useQueryClient();
  const contact = useQuery({ queryKey: portalKeys.myContact(), queryFn: getMyContact });
  const [form, setForm] = useState<Record<ConfirmField, string> | null>(null);
  useEffect(() => {
    if (contact.data && form === null) {
      setForm(Object.fromEntries(CONFIRM_FIELDS.map((f) => [f, contact.data?.[f] ?? ''])) as Record<ConfirmField, string>);
    }
  }, [contact.data, form]);
  const save = useMutation({
    mutationFn: () => {
      const original = contact.data;
      const changed = Object.fromEntries(CONFIRM_FIELDS.filter((f) => form && (original?.[f] ?? '') !== form[f]).map((f) => [f, form![f]]));
      if (Object.keys(changed).length === 0) return Promise.resolve('unchanged');
      return track(saveContactDetails(listId, changed));
    },
    onSuccess: (status) => {
      toast.success(status === 'unchanged' ? 'Your details are confirmed.' : 'Your details are saved.');
      void queryClient.invalidateQueries({ queryKey: portalKeys.myContact() });
    },
    onError: (err) => toast.error(getErrorMessage(err, 'Your details did not save. Try again.')),
  });
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" aria-labelledby="confirm-details-heading">
      <h2 id="confirm-details-heading" className="text-[14px] font-semibold">
        Confirm your details
      </h2>
      {!form && <Skeleton className="h-20 w-full" />}
      {form && (
        <div className="grid gap-3 sm:grid-cols-2">
          {CONFIRM_FIELDS.map((f) => (
            <div key={f} className="flex flex-col gap-1.5">
              <Label htmlFor={`confirm-${f}`}>{FIELD_LABELS[f]}</Label>
              <Input
                id={`confirm-${f}`}
                value={form[f]}
                disabled={!editable}
                type={f === 'email' ? 'email' : f === 'phone' ? 'tel' : 'text'}
                onChange={(e) => setForm({ ...form, [f]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
      <div>
        <Button size="sm" variant="outline" disabled={!editable || !form || save.isPending} onClick={() => save.mutate()} title={!editable ? READ_ONLY_TITLE : undefined}>
          Save details
        </Button>
      </div>
    </section>
  );
}
