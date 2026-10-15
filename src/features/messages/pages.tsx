import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, MessageSquare } from 'lucide-react';
import { isUuid } from '@/api/contacts';
import { EmptyState, PAGE, PageHeader, Surface } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { links } from '@/features/links';
import type { ContactTabProps } from '@/features/types';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { conversationName, getConversationContact, listConversations, type Conversation } from './api';
import { ConversationView } from './components/ConversationView';
import { EncryptionGate } from './components/EncryptionGate';
import { useEncryptionSession } from './keySession';
import { messagesKeys } from './keys';
import { useOwnerMessageChanges } from './realtime';

/** Lock, in the page header, while unlocked. */
function LockButton() {
  const { privateKey, lock } = useEncryptionSession();
  if (!privateKey) return null;
  return (
    <Button variant="ghost" size="xs" onClick={lock}>
      <Lock aria-hidden="true" />
      Lock
    </Button>
  );
}

/** The owner's inbox: one row per contact with messages, newest activity first. */
export function MessagesPage() {
  useEffect(() => {
    document.title = 'Messages';
  }, []);
  return (
    <>
      <PageHeader title="Messages" subtitle="Secure messages with your clients." actions={<LockButton />} />
      <div className={PAGE}>
        <EncryptionGate>{() => <ConversationList />}</EncryptionGate>
      </div>
    </>
  );
}

function ConversationList() {
  const queryClient = useQueryClient();
  // Rendered only inside the gate: nothing is listed until the owner has unlocked.
  const list = useQuery({ queryKey: messagesKeys.conversations(), queryFn: listConversations });

  useOwnerMessageChanges('owner-inbox', () => {
    void queryClient.invalidateQueries({ queryKey: messagesKeys.conversations() });
    void queryClient.invalidateQueries({ queryKey: messagesKeys.unread() });
  });

  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  if (list.isError) {
    return <p role="alert" className="text-sm text-destructive">Could not load conversations: {getErrorMessage(list.error)}</p>;
  }
  if (list.data.length === 0) {
    return (
      <Surface>
        <EmptyState icon={<MessageSquare />} title="No messages yet" description="Messages from your clients appear here." />
      </Surface>
    );
  }
  return (
    <Surface padding={false}>
      <ul className="divide-y" aria-label="Conversations">
        {list.data.map((c) => (
          <li key={c.contact_id}>
            <ConversationRow conversation={c} />
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function ConversationRow({ conversation: c }: { conversation: Conversation }) {
  const name = conversationName(c);
  const unread = c.unread_count > 0;
  const preview = c.last_message_sender_role === 'client' ? 'Encrypted message' : `You: ${c.last_message_body ?? ''}`;
  return (
    <Link
      to={links.conversation(c.contact_id)}
      className="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {unread && <span className="size-[7px] shrink-0 rounded-full bg-link" aria-hidden="true" />}
          <span className={cn('truncate text-[13px]', unread ? 'font-semibold' : 'font-medium')}>{name}</span>
        </div>
        <p className={cn('mt-0.5 truncate text-xs text-muted-foreground', c.last_message_sender_role === 'client' && 'italic')}>{preview}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs text-muted-foreground">{formatDateTime(c.last_message_at)}</span>
        <CountBadge value={c.unread_count} title="Unread messages" />
      </div>
    </Link>
  );
}

/** One conversation, full height: the list scrolls, the reply box stays put. */
export function ConversationPage() {
  const { contactId } = useParams();
  const [search] = useSearchParams();
  const valid = isUuid(contactId);
  const contact = useQuery({
    queryKey: messagesKeys.contact(contactId ?? ''),
    queryFn: () => getConversationContact(contactId as string),
    enabled: valid,
  });
  const name = contact.data ?? 'Conversation';

  useEffect(() => {
    document.title = 'Messages';
  }, []);

  const header = (
    <PageHeader
      title={name}
      actions={
        <>
          <Button asChild variant="ghost" size="xs">
            <Link to={links.messages()}>
              <ArrowLeft aria-hidden="true" />
              All messages
            </Link>
          </Button>
          <LockButton />
        </>
      }
    />
  );

  if (!valid || (contact.isSuccess && contact.data === null)) {
    return (
      <>
        {header}
        <div className={PAGE}>
          <p className="text-sm text-muted-foreground">There is no contact at this address.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex h-full min-h-0 flex-col px-4 pb-4 pt-3 md:px-5">
        {contact.isError && (
          <p role="alert" className="mb-2 text-sm text-destructive">Could not load the contact: {getErrorMessage(contact.error)}</p>
        )}
        <EncryptionGate>
          {(privateKey) =>
            contact.data ? (
              <ConversationView
                contactId={contactId}
                contactName={contact.data}
                privateKey={privateKey}
                focusComposer={search.get('compose') === '1'}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )
          }
        </EncryptionGate>
      </div>
    </>
  );
}

/** The contact record's Messages tab: the same conversation, in a fixed-height pane. */
export function MessagesTab({ contactId }: ContactTabProps) {
  const contact = useQuery({
    queryKey: messagesKeys.contact(contactId),
    queryFn: () => getConversationContact(contactId),
  });
  return (
    <div className="flex h-[600px] max-h-[75svh] min-h-0 flex-col">
      <EncryptionGate>
        {(privateKey) =>
          contact.data ? (
            <ConversationView contactId={contactId} contactName={contact.data} privateKey={privateKey} />
          ) : contact.isError ? (
            <p role="alert" className="text-sm text-destructive">Could not load the contact: {getErrorMessage(contact.error)}</p>
          ) : (
            <Skeleton className="h-40 w-full" />
          )
        }
      </EncryptionGate>
    </div>
  );
}
