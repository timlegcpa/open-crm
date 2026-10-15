import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, MessageSquare, Trash2 } from 'lucide-react';
import { EmptyState } from '@/components/layout/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { deleteMessages, listConversation, markClientMessagesRead, sendReply } from '../api';
import { decryptMessage, MESSAGE_MAX_LENGTH } from '../crypto';
import { messagesKeys } from '../keys';
import type { Message } from '../messageRows';
import { useOwnerMessageChanges } from '../realtime';

/** What a client's message shows: still opening, its text, or that it could not be opened. */
type Opened = { state: 'ok'; text: string } | { state: 'failed' };

/** One contact's conversation for the owner: oldest first, the reply box pinned under it. */
export function ConversationView({
  contactId,
  contactName,
  privateKey,
  focusComposer = false,
}: {
  contactId: string;
  contactName: string;
  privateKey: CryptoKey;
  focusComposer?: boolean;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<Map<string, Opened>>(() => new Map());
  const endRef = useRef<HTMLDivElement>(null);

  const conversation = useQuery({
    queryKey: messagesKeys.conversation(contactId),
    queryFn: () => listConversation(contactId),
  });
  const messages = conversation.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: messagesKeys.conversation(contactId) });
    void queryClient.invalidateQueries({ queryKey: messagesKeys.conversations() });
    void queryClient.invalidateQueries({ queryKey: messagesKeys.unread() });
  };

  // Any change anywhere (a new message, a read, a delete from another session) refreshes
  // this conversation, the inbox and the counts.
  useOwnerMessageChanges('owner-conversation', refresh);

  // Viewing a conversation reads it. markClientMessagesRead never throws and sends each id
  // once even when a refetch re-runs this before the last call returned.
  useEffect(() => {
    const unread = (messages ?? []).filter((m) => m.sender_role === 'client' && !m.read_at).map((m) => m.id);
    if (unread.length === 0) return;
    void markClientMessagesRead(unread).then(() => {
      void queryClient.invalidateQueries({ queryKey: messagesKeys.unread() });
      void queryClient.invalidateQueries({ queryKey: messagesKeys.conversations() });
    });
  }, [messages, queryClient]);

  // Opens each client message once, in the browser, with the unlocked key.
  useEffect(() => {
    const pending = (messages ?? []).filter((m) => m.is_encrypted && !opened.has(m.id));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async (m): Promise<[string, Opened]> => {
        try {
          const text = await decryptMessage(m.encrypted_body ?? '', m.encrypted_key ?? '', m.encryption_iv ?? '', privateKey);
          return [m.id, { state: 'ok', text }];
        } catch {
          return [m.id, { state: 'failed' }];
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setOpened((prev) => new Map([...prev, ...results]));
    });
    return () => {
      cancelled = true;
    };
  }, [messages, opened, privateKey]);

  // The newest message is the last one; keep it in view.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, opened]);

  const send = useMutation({
    mutationFn: (body: string) => {
      const senderId = session?.user?.id;
      if (!senderId) throw new Error('You are signed out.');
      return sendReply(contactId, senderId, body);
    },
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) => deleteMessages(ids),
    onSuccess: (_, ids) => {
      setOpened((prev) => {
        const next = new Map(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      refresh();
    },
  });

  const removeIds = async (ids: string[], done?: string) => {
    try {
      await remove.mutateAsync(ids);
      if (done) toast.success(done);
    } catch (err) {
      toast.error(getErrorMessage(err, 'The message was not deleted.'));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b px-1 pb-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3" aria-hidden="true" />
          Messages from {contactName} are end-to-end encrypted.
        </p>
        {messages && messages.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive">
                <Trash2 aria-hidden="true" />
                Delete all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete the whole conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  All {messages.length} messages with {contactName} are deleted for good, for you and for them.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void removeIds(messages.map((m) => m.id), `Deleted the conversation with ${contactName}.`)}
                >
                  Delete all
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1" fitWidth>
        {conversation.isPending && <p className="p-4 text-sm text-muted-foreground">Loading messages...</p>}
        {conversation.isError && (
          <p role="alert" className="p-4 text-sm text-destructive">
            Could not load messages: {getErrorMessage(conversation.error)}
          </p>
        )}
        {messages?.length === 0 && (
          <EmptyState icon={<MessageSquare />} title="No messages yet" description={`Write to ${contactName} below.`} />
        )}
        {messages && messages.length > 0 && (
          // Oldest first, so the newest sits just above the reply box.
          <ol className="flex flex-col divide-y" aria-label={`Messages with ${contactName}`}>
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                author={m.sender_role === 'owner' ? 'You' : contactName}
                opened={opened.get(m.id)}
                onDelete={() => void removeIds([m.id])}
                deleting={remove.isPending}
              />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </ScrollArea>

      <Composer
        contactName={contactName}
        autoFocus={focusComposer}
        onSend={async (body) => {
          try {
            await send.mutateAsync(body);
            return true;
          } catch (err) {
            toast.error(getErrorMessage(err, 'The reply was not sent.'));
            return false;
          }
        }}
        sending={send.isPending}
      />
    </div>
  );
}

function MessageRow({
  message,
  author,
  opened,
  onDelete,
  deleting,
}: {
  message: Message;
  author: string;
  opened: Opened | undefined;
  onDelete: () => void;
  deleting: boolean;
}) {
  const fromClient = message.sender_role === 'client';
  let text: string;
  let muted = false;
  if (!fromClient) text = message.body ?? '';
  else if (!opened) {
    text = 'Opening...';
    muted = true;
  } else if (opened.state === 'failed') {
    text = 'This message could not be opened with your key.';
    muted = true;
  } else text = opened.text;

  return (
    <li className="group flex items-start gap-3 px-1 py-3">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-medium">{author}</span>
          <span className="text-xs text-muted-foreground">{formatDateTime(message.created_at)}</span>
          {fromClient && <Lock className="size-3 text-muted-foreground" aria-label="Encrypted" />}
        </div>
        <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', muted && 'italic text-muted-foreground')}>{text}</p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={`Delete message from ${formatDateTime(message.created_at)}`}
        onClick={onDelete}
        disabled={deleting}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

/** The reply box: Enter sends, Shift+Enter is a new line. The draft is cleared only once the reply is saved. */
function Composer({
  contactName,
  onSend,
  sending,
  autoFocus,
}: {
  contactName: string;
  onSend: (body: string) => Promise<boolean>;
  sending: boolean;
  autoFocus: boolean;
}) {
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    if (await onSend(body)) setDraft((current) => (current === draft ? '' : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="shrink-0 border-t pt-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor="owner-reply" className="sr-only">Reply to {contactName}</Label>
      <Textarea
        id="owner-reply"
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MESSAGE_MAX_LENGTH))}
        onKeyDown={onKeyDown}
        placeholder={`Reply to ${contactName} (Enter to send, Shift+Enter for a new line)`}
        rows={3}
        className="max-h-56 resize-y"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Your replies are not end-to-end encrypted. Clients' messages are.</span>
        <Button type="submit" size="sm" disabled={!draft.trim() || sending}>
          {sending && <Loader2 className="animate-spin" aria-hidden="true" />}
          Send reply
        </Button>
      </div>
    </form>
  );
}
