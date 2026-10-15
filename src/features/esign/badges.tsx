import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { links } from '@/features/links';
import type { ContactTabProps } from '@/features/types';
import { countPendingForContact } from './api';
import { esignKeys } from './keys';

/**
 * The count beside a contact's E-sign tab: envelopes still in draft or out for signature,
 * never the total. Its own module so the contact record does not download the composer to
 * draw a number.
 */
export function EsignContactBadge({ contactId }: ContactTabProps) {
  const { data } = useQuery({
    queryKey: esignKeys.pendingCount(contactId),
    queryFn: () => countPendingForContact(contactId),
    staleTime: 60_000,
  });
  return <CountBadge value={data} title="Envelopes waiting" />;
}

/** The contact header's E-sign button: a new envelope for this contact. */
export function EsignHeaderAction({ contactId }: ContactTabProps) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={links.newEnvelope({ contactId })} aria-label="New envelope for this contact">
        <PenLine aria-hidden="true" />
        E-sign
      </Link>
    </Button>
  );
}
