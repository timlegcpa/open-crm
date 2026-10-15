import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, MessageSquare, Send } from 'lucide-react';
import { EmptyState } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MESSAGE_MAX_LENGTH } from './crypto';
import { portalMessagesKeys } from './keys';
import type { Message } from './messageRows';
import {
  countUnreadReplies,
  getOrgName,
  getOrgPublicKey,
  isViewAsClient,
  listMyMessages,
  markRepliesRead,
  sendEncrypted,
} from './portalApi';
import { useClientNewMessages } from './realtime';

/** On the portal's Messages tab: replies waiting to be read. */
export function PortalUnreadBadge() {
  const { data } = useQuery({
    queryKey: portalMessagesKeys.unread(),
    queryFn: countUnreadReplies,
    staleTime: 60_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  return <CountBadge value={data} title="Unread messages" />;
}

/**
 * The client's secure conversation: a message box, then the conversation newest first.
 * What the client sends is encrypted in this browser; the text it just wrote is kept in
 * memory for this page only, so a message sent earlier shows as encrypted.
 */
export function PortalMessagesPage() {
  const { session, clientContactId } = useAuth();
  const userId = session?.user?.id ?? null;
  const queryClient = useQueryClient();
  const sentText = useRef(new Map<string, string>());
  const markedRead = useRef(new Set<string>());

  const orgName = useQuery({ queryKey: portalMessagesKeys.orgName(), queryFn: getOrgName, staleTime: Infinity }).data ?? 'us';
  // The owner's key never changes once set up. Until it exists, look again now and then, so
  // a page opened before setup gets its message box without a reload.
  const publicKey = useQuery({
    queryKey: portalMessagesKeys.publicKey(),
    queryFn: getOrgPublicKey,
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.data ? false : 30_000),
  });
  const viewing = useQuery({ queryKey: portalMessagesKeys.viewAsClient(), queryFn: isViewAsClient, staleTime: Infinity });
  const messages = useQuery({
    queryKey: portalMessagesKeys.list(),
    queryFn: listMyMessages,
    // Every refetch is a new list, even when nothing changed, so the mark-read effect below
    // runs again and retries ids a failed call gave back.
    structuralSharing: false,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  // Viewing as client reads; it never marks anything read. Only once the answer is known.
  const readOnly = viewing.data !== false;

  useClientNewMessages(clientContactId, () => {
    void queryClient.invalidateQueries({ queryKey: portalMessagesKeys.list() });
    void queryClient.invalidateQueries({ queryKey: portalMessagesKeys.unread() });
  });

  // The owner's replies are read when this page shows them. An id is sent once while its
  // call runs, so a refetch does not send it again; if the call fails, the id is freed and
  // the next refetch tries it again.
  useEffect(() => {
    if (readOnly || !clientContactId || !userId) return;
    const unread = (messages.data ?? [])
      .filter((m) => m.sender_role === 'owner' && !m.read_at && !markedRead.current.has(m.id))
      .map((m) => m.id);
    if (unread.length === 0) return;
    unread.forEach((id) => markedRead.current.add(id));
    void markRepliesRead(unread, clientContactId, userId).then((marked) => {
      if (!marked) {
        unread.forEach((id) => markedRead.current.delete(id));
        return;
      }
      void queryClient.invalidateQueries({ queryKey: portalMessagesKeys.unread() });
    });
  }, [messages.data, readOnly, clientContactId, userId, queryClient]);

  const newestFirst = useMemo(() => [...(messages.data ?? [])].reverse(), [messages.data]);

  const send = async (text: string): Promise<boolean> => {
    if (!publicKey.data || !clientContactId || !userId) return false;
    try {
      const id = await sendEncrypted(text, publicKey.data, clientContactId, userId);
      sentText.current.set(id, text);
      void queryClient.invalidateQueries({ queryKey: portalMessagesKeys.list() });
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, 'Your message was not sent.'));
      return false;
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Messages</h1>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            What you send is encrypted in your browser, and only {orgName} can read it. Replies from {orgName} are not
            end-to-end encrypted. You can read a message you sent only until you leave this page.
          </span>
        </p>
      </div>

      {publicKey.isPending || viewing.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : publicKey.isError ? (
        <p role="alert" className="text-sm text-destructive">Messages could not be loaded: {getErrorMessage(publicKey.error)}</p>
      ) : !publicKey.data ? (
        <div className="rounded-lg border bg-card p-4 text-center">
          <p className="text-sm">Secure messages are not available yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">{orgName} has not finished setting them up.</p>
        </div>
      ) : (
        <ClientComposer orgName={orgName} onSend={send} disabledReason={readOnly ? 'Sending is off while viewing as client.' : null} />
      )}

      {messages.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : messages.isError ? (
        <p role="alert" className="text-sm text-destructive">Messages could not be loaded: {getErrorMessage(messages.error)}</p>
      ) : newestFirst.length === 0 ? (
        <EmptyState icon={<MessageSquare />} title="No messages yet" description={`Write to ${orgName} in the box above.`} />
      ) : (
        <ol className="flex flex-col gap-2.5" aria-label="Your messages">
          {newestFirst.map((m) => (
            <ClientMessageRow key={m.id} message={m} orgName={orgName} sentText={sentText.current.get(m.id)} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ClientMessageRow({ message, orgName, sentText }: { message: Message; orgName: string; sentText: string | undefined }) {
  const mine = message.sender_role === 'client';
  const text = mine ? sentText : message.body ?? '';
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('w-full rounded-lg border p-3.5 sm:max-w-[85%]', mine ? 'bg-muted' : 'bg-card')}>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-semibold">{mine ? 'You' : orgName}</span>
          {!mine && !message.read_at && <span className="text-[11px] font-semibold text-link">New</span>}
          <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(message.created_at)}</span>
        </div>
        {text === undefined ? (
          <p className="text-sm italic text-muted-foreground">Encrypted message</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</p>
        )}
      </div>
    </li>
  );
}

/** Enter sends, Shift+Enter is a new line. One send at a time, even within a single tick. */
function ClientComposer({
  orgName,
  onSend,
  disabledReason,
}: {
  orgName: string;
  onSend: (text: string) => Promise<boolean>;
  disabledReason: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // Enter and a click can both fire before the `sending` state re-renders the button; a
  // ref changes at once, so this is the guard that actually closes that window.
  const inFlight = useRef(false);

  const submit = async () => {
    const text = draft.trim();
    if (!text || inFlight.current || disabledReason) return;
    inFlight.current = true;
    setSending(true);
    try {
      if (await onSend(text)) setDraft((current) => (current === draft ? '' : current));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor="client-message">New message to {orgName}</Label>
      <Textarea
        id="client-message"
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MESSAGE_MAX_LENGTH))}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={disabledReason !== null}
        className="max-h-40 resize-y"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{disabledReason ?? 'Enter to send, Shift+Enter for a new line.'}</span>
        <Button type="submit" size="sm" disabled={!draft.trim() || sending || disabledReason !== null}>
          {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          Send securely
        </Button>
      </div>
    </form>
  );
}
