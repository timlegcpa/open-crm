import { PlaceholderPage } from '@/components/layout/page';
import type { ContactTabProps } from '@/features/types';

// Placeholders: the e-sign feature replaces these.

export function EsignPage() {
  return <PlaceholderPage title="E-sign" line="Every envelope sent for signature, and where each one stands." />;
}

export function NewEnvelopePage() {
  return <PlaceholderPage title="New envelope" line="Choose a document, place the fields and send it for signature." />;
}

export function EnvelopePage() {
  return <PlaceholderPage title="Envelope" line="One envelope: its signers, its history and the signed copy." />;
}

export function PortalSignPage() {
  return <PlaceholderPage title="Sign" line="Documents waiting for your signature." />;
}

export function EsignTab(_props: ContactTabProps) {
  return <p className="text-[13px] text-muted-foreground">This contact's envelopes will be listed here.</p>;
}
