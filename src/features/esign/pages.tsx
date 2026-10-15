import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { EmptyState, PAGE, PageHeader, Panel, TABLE_TH, TABLE_TR } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isUuid } from '@/api/contacts';
import { links } from '@/features/links';
import type { ContactTabProps } from '@/features/types';
import { getErrorMessage } from '@/lib/errors';
import { formatDate, NO_VALUE_TEXT } from '@/lib/format';
import { getEnvelope, listEnvelopesForContact } from './api';
import { Composer } from './components/Composer';
import { EnvelopeDetail } from './components/EnvelopeDetail';
import { EnvelopeList } from './components/EnvelopeList';
import { NewEnvelopeForm } from './components/NewEnvelopeForm';
import { EsignStatusBadge } from './components/StatusBadge';
import { esignKeys } from './keys';
import { resolveSignerName } from './lib/signerName';

function Loading() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  );
}

/** /esign: every envelope, filtered by status. */
export function EsignPage() {
  return (
    <div className={PAGE}>
      <PageHeader
        title="E-sign"
        subtitle="Every envelope sent for signature, and where each one stands."
        actions={
          <Button asChild size="sm">
            <Link to={links.newEnvelope()}>
              <Plus aria-hidden="true" />
              New envelope
            </Link>
          </Button>
        }
      />
      <EnvelopeList />
    </div>
  );
}

/** /esign/new: start a draft, for a contact (?contact=) or from a stored document (?document=). */
export function NewEnvelopePage() {
  const [params] = useSearchParams();
  // Only well-formed ids reach a query; anything else is ignored rather than sent.
  const contact = params.get('contact');
  const document = params.get('document');
  return (
    <div className={PAGE}>
      <PageHeader title="New envelope" />
      <div className="mx-auto w-full max-w-xl">
        <NewEnvelopeForm contactId={contact && isUuid(contact) ? contact : null} documentId={document && isUuid(document) ? document : null} />
      </div>
    </div>
  );
}

/** /esign/:id: the composer while the envelope is a draft, its detail once sent. */
export function EnvelopePage() {
  const { id = '' } = useParams();
  const valid = isUuid(id);
  const envelope = useQuery({ queryKey: esignKeys.envelope(id), queryFn: () => getEnvelope(id), enabled: valid });

  let body;
  if (!valid || envelope.data === null) {
    body = <EmptyState title="This envelope could not be found" description="It may have been deleted." />;
  } else if (envelope.isPending) {
    body = <Loading />;
  } else if (envelope.isError) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        Could not load the envelope: {getErrorMessage(envelope.error)}
      </p>
    );
  }
  if (body || !envelope.data) {
    return (
      <div className={PAGE}>
        <PageHeader title="Envelope" />
        {body}
      </div>
    );
  }
  const row = envelope.data;
  return (
    <div className={PAGE}>
      <PageHeader title={row.title} subtitle={row.status === 'draft' ? 'Draft' : undefined} />
      {row.status === 'draft' ? <Composer key={row.id} envelope={row} /> : <EnvelopeDetail envelope={row} />}
    </div>
  );
}

/** The contact record's E-sign tab: this contact's envelopes, newest first. */
export function EsignTab({ contactId }: ContactTabProps) {
  const envelopes = useQuery({ queryKey: esignKeys.forContact(contactId), queryFn: () => listEnvelopesForContact(contactId) });
  const rows = envelopes.data ?? [];
  return (
    <Panel
      title="Envelopes"
      action={
        <Button asChild size="xs">
          <Link to={links.newEnvelope({ contactId })}>
            <Plus aria-hidden="true" />
            New envelope
          </Link>
        </Button>
      }
      bodyClassName="p-0"
    >
      {envelopes.isPending ? (
        <Loading />
      ) : envelopes.isError ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          Could not load the envelopes: {getErrorMessage(envelopes.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-[13px] text-muted-foreground">No envelopes for this contact yet.</p>
      ) : (
        <ScrollArea horizontal>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={TABLE_TH}>Title</TableHead>
                <TableHead className={TABLE_TH}>Status</TableHead>
                <TableHead className={TABLE_TH}>Signers</TableHead>
                <TableHead className={TABLE_TH}>Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id} className={TABLE_TR}>
                  <TableCell className="max-w-[280px] truncate text-[13px]">
                    <Link to={links.envelope(e.id)} className="font-medium text-link underline-offset-4 hover:underline">
                      {e.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <EsignStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-[13px] text-muted-foreground">
                    {e.signers.length > 0 ? e.signers.map((s) => resolveSignerName(s)).join(', ') : NO_VALUE_TEXT}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
                    {e.sent_at ? formatDate(e.sent_at) : NO_VALUE_TEXT}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </Panel>
  );
}
