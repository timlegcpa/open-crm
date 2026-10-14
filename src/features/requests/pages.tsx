import { PlaceholderPage } from '@/components/layout/page';
import type { ContactTabProps } from '@/features/types';

// Placeholders: the requests feature replaces these.

export function RequestsPage() {
  return <PlaceholderPage title="Requests" line="Every list of items asked of a client, and what came back." />;
}

export function NewRequestPage() {
  return <PlaceholderPage title="New request" line="Ask a contact for a list of items." />;
}

export function RequestPage() {
  return <PlaceholderPage title="Request" line="One request: each item, its answer and its status." />;
}

export function PortalRequestPage() {
  return <PlaceholderPage title="Request" line="The items asked of you, answered one at a time." />;
}

export function RequestsTab(_props: ContactTabProps) {
  return <p className="text-[13px] text-muted-foreground">This contact's requests will be listed here.</p>;
}

export function RequestsCard() {
  return <p className="text-[13px] text-muted-foreground">Requests waiting on you will appear here.</p>;
}
