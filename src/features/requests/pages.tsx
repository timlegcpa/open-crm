import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Plus } from 'lucide-react';
import { EmptyState, PAGE, PageHeader, Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/ui/tone-badge';
import { ContactPicker } from '@/components/contacts/ContactPicker';
import { contactDisplayName, getContact, isUuid, listContacts } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import type { ContactTabProps } from '@/features/types';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { getRequest, listRequests } from './api';
import { requestKeys } from './keys';
import { LIST_STATUS_LABELS, listProgress, requestSections, type RequestWithItems } from './lib/requests';
import { RequestBuilder } from './components/RequestBuilder';
import { DeleteRequestButton, LIST_TONES, RequestDetail } from './components/RequestDetail';

/** The owner's requests: what was handed back first, then what is waiting, drafts, and closed. */
export function RequestsPage() {
  const navigate = useNavigate();
  const requests = useQuery({ queryKey: requestKeys.lists(), queryFn: () => listRequests() });
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts });
  const names = new Map((contacts.data ?? []).map((c) => [c.id, contactDisplayName(c)]));
  const sections = requestSections(requests.data ?? []);
  const waiting = (requests.data ?? []).filter((r) => r.status === 'sent').length;

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle={requests.data ? `${waiting} waiting on clients` : undefined}
        actions={<NewRequestPicker onPick={(id) => navigate(links.newRequest(id))} />}
      />
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
          />
        )}
        {sections.map((section) => (
          <Panel key={section.status} title={`${LIST_STATUS_LABELS[section.status]} (${section.lists.length})`} bodyClassName="divide-y divide-border">
            {section.lists.map((r) => (
              <RequestRow key={r.id} request={r} contactName={names.get(r.contact_id) ?? null} />
            ))}
          </Panel>
        ))}
      </div>
    </>
  );
}

function NewRequestPicker({ onPick }: { onPick: (contactId: string) => void }) {
  return (
    <ContactPicker grouped onSelect={(c) => onPick(c.id)}>
      <Button size="sm" aria-label="New request: choose a contact">
        <Plus aria-hidden /> New request
      </Button>
    </ContactPicker>
  );
}

/** One request in a list: its title, who it is for, its status and progress. */
export function RequestRow({ request, contactName }: { request: RequestWithItems; contactName: string | null }) {
  const progress = listProgress(request.items);
  const when = request.sent_at ? `Sent ${formatDate(request.sent_at)}` : `Created ${formatDate(request.created_at)}`;
  return (
    <Link to={links.request(request.id)} className="flex flex-col gap-1 px-4 py-2.5 hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">{request.title}</p>
        <p className="truncate text-[12px] text-muted-foreground">{[contactName, when].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        {request.status !== 'draft' && <span className="tabular-nums">{`${progress.fulfilled} of ${progress.actionable} answered`}</span>}
        {progress.awaitingAccept > 0 && (request.status === 'sent' || request.status === 'submitted') && (
          <ToneBadge variant="warning">{`${progress.awaitingAccept} to accept`}</ToneBadge>
        )}
        <ToneBadge variant={LIST_TONES[request.status]}>{LIST_STATUS_LABELS[request.status]}</ToneBadge>
      </div>
    </Link>
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
  const navigate = useNavigate();
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
            action={<NewRequestPicker onPick={(id) => navigate(links.newRequest(id), { replace: true })} />}
          />
        )}
        {contactId && contact.isPending && <Skeleton className="h-40 w-full" />}
        {contactId && contact.isSuccess && !contact.data && <p className="text-[13px] text-muted-foreground">This contact no longer exists.</p>}
        {contactId && contact.data && <RequestBuilder contactId={contactId} contactName={name ?? 'this contact'} />}
      </div>
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
  const requests = useQuery({ queryKey: requestKeys.forContact(contactId), queryFn: () => listRequests(contactId) });
  const sections = requestSections(requests.data ?? []);
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
      {sections.map((section) => (
        <Panel key={section.status} title={`${LIST_STATUS_LABELS[section.status]} (${section.lists.length})`} bodyClassName="divide-y divide-border">
          {section.lists.map((r) => (
            <RequestRow key={r.id} request={r} contactName={null} />
          ))}
        </Panel>
      ))}
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
