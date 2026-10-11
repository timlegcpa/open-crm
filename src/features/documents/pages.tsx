import { PlaceholderPage } from '@/components/layout/page';
import type { ContactTabProps } from '@/features/types';

// Placeholders: the documents feature replaces these.

export function DocumentsPage() {
  return <PlaceholderPage title="Documents" line="Every file shared with a contact, by contact and by folder." />;
}

export function DocumentPage() {
  return <PlaceholderPage title="Document" line="One file: a preview, its details and what was done with it." />;
}

export function PortalDocumentsPage() {
  return <PlaceholderPage title="Documents" line="The files you shared and the files shared with you." />;
}

export function DocumentsTab(_props: ContactTabProps) {
  return <p className="text-[13px] text-muted-foreground">This contact's files will be listed here.</p>;
}

export function DocumentsCard() {
  return <p className="text-[13px] text-muted-foreground">New files shared with you will appear here.</p>;
}
