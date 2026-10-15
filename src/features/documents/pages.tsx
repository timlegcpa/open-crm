import { lazy, Suspense } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { EmptyState, PAGE, PageHeader } from '@/components/layout/page';
import { Skeleton } from '@/components/ui/skeleton';
import { contactDisplayName, getContact, isUuid } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { links } from '@/features/links';
import type { ContactTabProps } from '@/features/types';
import { documentKeys, getDocument, listDocumentsForContact } from './api';

// Each screen loads its own chunk: the portal's Home card must not download the explorer,
// and the explorer must not download pdf.js until a document is opened.
const AdminDocumentsExplorer = lazy(() => import('./explorer/AdminDocumentsExplorer'));
const DocumentWorkstation = lazy(() => import('./workstation/DocumentWorkstation'));
const PortalDocuments = lazy(() => import('./portal/PortalDocuments'));

const Loading = () => <Skeleton className="m-4 h-40" />;

/** /documents: every contact's files. `?contact=<id>` opens on one contact. */
export function DocumentsPage() {
  const [params] = useSearchParams();
  const contact = params.get('contact') ?? undefined;
  return (
    <Suspense fallback={<Loading />}>
      <AdminDocumentsExplorer variant="flush" initialClientId={isUuid(contact) ? contact : undefined} />
    </Suspense>
  );
}

/** /documents/:id: one document in the workstation, among its contact's other files. */
export function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const valid = isUuid(id);
  const doc = useQuery({
    queryKey: [...documentKeys.all, 'one', id ?? ''],
    queryFn: () => getDocument(id!),
    enabled: valid,
  });
  const contactId = doc.data?.contact_id;
  const contact = useQuery({
    queryKey: queryKeys.contacts.detail(contactId ?? ''),
    queryFn: () => getContact(contactId!),
    enabled: !!contactId,
  });

  if (valid && (doc.isPending || (contactId && contact.isPending))) return <Loading />;
  if (!valid || doc.isError || !doc.data || !contact.data) {
    return (
      <>
        <PageHeader title="Document" />
        <div className={PAGE}>
          <EmptyState
            icon={<FileText />}
            title="This document could not be opened"
            description="It may have been deleted, or the link is incomplete."
            action={<Link className="text-[13px] font-medium underline underline-offset-2" to={links.documents()}>Go to documents</Link>}
          />
        </div>
      </>
    );
  }
  const d = doc.data;
  return (
    <Suspense fallback={<Loading />}>
      <DocumentWorkstation
        contactId={d.contact_id}
        contactName={contactDisplayName(contact.data)}
        initialDocId={d.id}
        initialScope={{ kind: 'section', heldBy: d.held_by }}
        onClose={() => navigate(links.documents(d.contact_id))}
      />
    </Suspense>
  );
}

/** The client's documents, in the portal. */
export function PortalDocumentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <PortalDocuments />
    </Suspense>
  );
}

/** The contact record's Documents tab: the explorer, held to this one contact. */
export function DocumentsTab({ contactId }: ContactTabProps) {
  const contact = useQuery({
    queryKey: queryKeys.contacts.detail(contactId),
    queryFn: () => getContact(contactId),
  });
  if (contact.isPending) return <Loading />;
  if (!contact.data) return <p className="text-[13px] text-muted-foreground">This contact could not be loaded.</p>;
  return (
    <Suspense fallback={<Loading />}>
      <AdminDocumentsExplorer lockedClient={contact.data} />
    </Suspense>
  );
}

/** The portal Home card: the newest files shared with the client. */
export function DocumentsCard() {
  const { clientContactId } = useAuth();
  const shared = useQuery({
    queryKey: [...documentKeys.forContact(clientContactId ?? ''), 'owner'],
    queryFn: () => listDocumentsForContact(clientContactId!, 'owner'),
    enabled: !!clientContactId,
  });
  const rows = shared.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Documents</h2>
        <Link to={links.portalDocuments()} className="text-[13px] font-medium underline underline-offset-2">
          Open documents
        </Link>
      </div>
      {shared.isError ? (
        <p className="text-[13px] text-muted-foreground">Your documents could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {shared.isPending ? 'Loading.' : 'Nothing has been shared with you yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.slice(0, 3).map((d) => (
            <li key={d.id} className="flex min-w-0 items-center justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">{d.original_filename}</span>
              <span className="shrink-0 text-muted-foreground">{formatDate(d.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
