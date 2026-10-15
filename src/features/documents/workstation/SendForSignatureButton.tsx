import { PenLine } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { links } from '@/features/links';
import { isPdf } from '../viewer/mime';

/**
 * The viewer's way into e-sign: opens a new envelope for this contact that starts from
 * this document (e-sign's /esign/new?document= reads it through the documents API, so an
 * encrypted upload works the same as a shared file). PDFs only; anything else renders
 * nothing. The workstation is an owner screen and never mounts in the portal, so View as
 * client never shows it.
 */
export default function SendForSignatureButton({
  contactId,
  documentId,
  mimeType,
}: {
  contactId: string;
  documentId: string;
  mimeType: string;
}) {
  const navigate = useNavigate();
  if (!isPdf(mimeType)) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => navigate(links.newEnvelope({ contactId, documentId }))}
      title="Send this document for signature"
    >
      <PenLine />
      Send for signature
    </Button>
  );
}
