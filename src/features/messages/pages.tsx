import { PlaceholderPage } from '@/components/layout/page';
import type { ContactTabProps } from '@/features/types';

// Placeholders: the messages feature replaces these.

export function MessagesPage() {
  return <PlaceholderPage title="Messages" line="Secure conversations with contacts, newest first." />;
}

export function ConversationPage() {
  return <PlaceholderPage title="Conversation" line="One contact's messages, and a reply box." />;
}

export function PortalMessagesPage() {
  return <PlaceholderPage title="Messages" line="Your secure conversation with us." />;
}

export function MessagesTab(_props: ContactTabProps) {
  return <p className="text-[13px] text-muted-foreground">This contact's messages will be listed here.</p>;
}
