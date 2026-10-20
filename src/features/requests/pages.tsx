import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Plus } from 'lucide-react';
import { EmptyState, PAGE, PageHeader } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/ui/tone-badge';
import { contactDisplayName, getContact, isUuid, listContacts } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import type { ContactTabProps } from '@/features/types';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { getRequest, listRequests } from './api';
import { LIST_REFRESH, requestKeys } from './keys';
import { RequestBuilder } from './components/RequestBuilder';
import { DeleteRequestButton, RequestDetail } from './components/RequestDetail';
import { NewRequestDialog } from './components/NewRequestDialog';
import { RequestRoster } from './components/RequestRoster';

/** The owner's requests, every contact's, grouped by whose move it is. */
export function RequestsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const requests = useQuery({ queryKey: requestKeys.lists(), queryFn: () => listRequests(), ...LIST_REFRESH });
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts });
  const names = new Map((contacts.data ?? []).map((c) => [c.id, contactDisplayName(c)]));
  const waiting = (requests.data ?? []).filter((r) => r.status === 'sent').length;
  const newButton = (
    <Button size="sm" onClick={() => setNewOpen(true)}>
      <Plus aria-hidden /> New request
    </Button>
  );

  return (
    <>
      <PageHeader title="Requests" subtitle={requests.data ? `${waiting} waiting on clients` : undefined} actions={newButton} />
      <div className={`${PAGE} flex flex-col gap-4`}>
        {requests.isPending && <Skeleton className="h-24 w-full" />}
        {requests.error && (
          <p role="alert" className="text-[13px] text-destructive">
            Could not load requests: {getErrorMessage(requests.error)}
          </p>
        )}
        {requests.data?.length === 0 && (
          <EmptyState
            icon={<Inbox />}
            title="No requests yet"
            description="Ask a client for documents, answers or tasks, and follow what comes back."
            action={newButton}
          />
        )}
        {requests.data && <RequestRoster requests={requests.data} contactName={(id) => names.get(id) ?? null} />}
      </div>
      <NewRequestDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  );
}

function useContactName(contactId: string | null) {
  const contact = useQuery({
    queryKey: queryKeys.contacts.detail(contactId ?? ''),
    queryFn: () => getContact(contactId!),
    enabled: contactId !== null,
  });
  return { contact, name: contact.data ? contactDisplayName(contact.data) : null };
}

/** /requests/new?contact=<id>: the builder, for one contact. */
export function NewRequestPage() {
  const [pickOpen, setPickOpen] = useState(false);
  const [params] = useSearchParams();
  const raw = params.get('contact') ?? undefined;
  const contactId = isUuid(raw) ? raw : null;
  const { contact, name } = useContactName(contactId);

  return (
    <>
      <PageHeader title="New request" subtitle={name ?? undefined} />
      <div className={PAGE}>
        {!contactId && (
          <EmptyState
            icon={<Inbox />}
            title="Choose who the request is for"
            action={
              <Button size="sm" onClick={() => setPickOpen(true)}>
                Choose a contact
              </Button>
            }
          />
        )}
        {contactId && contact.isPending && <Skeleton className="h-40 w-full" />}
        {contactId && contact.isSuccess && !contact.data && <p className="text-[13px] text-muted-foreground">This contact no longer exists.</p>}
        {contactId && contact.data && <RequestBuilder contactId={contactId} contactName={name ?? 'this contact'} />}
      </div>
      <NewRequestDialog open={pickOpen} onOpenChange={setPickOpen} />
    </>
  );
}

/** /requests/:id: a draft opens in the builder; anything sent opens its detail. */
export function RequestPage() {
  const { id } = useParams();
  const requestId = isUuid(id) ? id : null;
  const request = useQuery({
    queryKey: requestKeys.detail(requestId ?? ''),
    queryFn: () => getRequest(requestId!),
    enabled: requestId !== null,
    // A sent request follows the client's answers; a draft is in the builder, where a
    // refetch would replace what is being typed.
    ...LIST_REFRESH,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'draft' ? LIST_REFRESH.refetchInterval : false),
    refetchOnWindowFocus: (q) => (q.state.data && q.state.data.status !== 'draft' ? 'always' : false),
  });
  const { name } = useContactName(request.data?.contact_id ?? null);
  const data = request.data;

  return (
    <>
      <PageHeader
        title={data?.title ?? 'Request'}
        subtitle={name ?? undefined}
        actions={
          data ? (
            <Button asChild size="sm" variant="ghost">
              <Link to={links.contactTab(data.contact_id, 'requests')}>All requests for this contact</Link>
            </Button>
          ) : undefined
        }
      />
      <div className={PAGE}>
        {request.isPending && requestId && <Skeleton className="h-40 w-full" />}
        {request.error && (
          <p role="alert" className="text-[13px] text-destructive">
            Could not load the request: {getErrorMessage(request.error)}
          </p>
        )}
        {(!requestId || (request.isSuccess && !data)) && (
          <EmptyState
            icon={<Inbox />}
            title="This request no longer exists"
            action={
              <Button asChild size="sm" variant="outline">
                <Link to={links.requests()}>All requests</Link>
              </Button>
            }
          />
        )}
        {data?.status === 'draft' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge variant="default">Draft</ToneBadge>
              <span className="text-[13px] text-muted-foreground">Not sent yet: the client cannot see it.</span>
              <div className="ml-auto">
                <DeleteRequestButton request={data} />
              </div>
            </div>
            <RequestBuilder key={`${data.id}:${data.content_version}`} contactId={data.contact_id} contactName={name ?? 'this contact'} draft={data} />
          </div>
        )}
        {data && data.status !== 'draft' && <RequestDetail request={data} />}
      </div>
    </>
  );
}

/** A contact's Requests tab. */
export function RequestsTab({ contactId }: ContactTabProps) {
  const requests = useQuery({ queryKey: requestKeys.forContact(contactId), queryFn: () => listRequests(contactId), ...LIST_REFRESH });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button asChild size="sm">
          <Link to={links.newRequest(contactId)}>
            <Plus aria-hidden /> New request
          </Link>
        </Button>
      </div>
      {requests.isPending && <Skeleton className="h-20 w-full" />}
      {requests.error && (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load requests: {getErrorMessage(requests.error)}
        </p>
      )}
      {requests.data?.length === 0 && <EmptyState icon={<Inbox />} title="No requests for this contact" description="Ask for documents, answers or tasks." />}
      {requests.data && <RequestRoster requests={requests.data} />}
    </div>
  );
}

/** The contact header's New request button. */
export function NewRequestAction({ contactId }: ContactTabProps) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to={links.newRequest(contactId)}>New request</Link>
    </Button>
  );
}
