import { Suspense, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactDisplayName, deleteContact, getContact, isUuid, type Contact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { StatusBadge } from '@/components/contacts/StatusBadge';
import { ContactFieldsForm } from '@/components/contacts/ContactFieldsForm';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';
import { ContactNotesPanel } from '@/components/contacts/ContactNotesPanel';
import { HouseholdPanel } from '@/components/contacts/HouseholdPanel';
import { SIDE_BAR_W } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { PAGE_TAB_TRIGGER, PAGE_TABS_LIST } from '@/components/ui/page-tabs';
import { links } from '@/features/links';
import { contactHeaderActions, contactSidePanels, contactTabs } from '@/features/registry';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getErrorMessage } from '@/lib/errors';

function OverviewTab({ contact }: { contact: Contact }) {
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <ContactFieldsForm contact={contact} />
      <div className="flex flex-col gap-8">
        <ContactEmailsManager contactId={contact.id} />
        <HouseholdPanel contactId={contact.id} />
        <ContactNotesPanel contactId={contact.id} />
      </div>
    </div>
  );
}

/**
 * The record's tab strip. Overview is the record itself (/contacts/:id); every other tab is
 * a feature's `contactTabs` entry at /contacts/:id/<key> (links.contactTab), so a tab is a
 * URL that can be linked to, and a feature adds one by editing its own manifest.
 */
function RecordTabs({ contactId, current }: { contactId: string; current: string | null }) {
  const tabs = [
    { key: null, label: 'Overview', to: links.contact(contactId), badge: undefined },
    ...contactTabs.map((t) => ({ key: t.key, label: t.label, to: links.contactTab(contactId, t.key), badge: t.badge })),
  ];
  return (
    <nav aria-label="Contact sections" className={PAGE_TABS_LIST}>
      {tabs.map(({ key, label, to, badge: Badge }) => {
        const active = key === current;
        return (
          <Link
            key={key ?? 'overview'}
            to={to}
            aria-current={active ? 'page' : undefined}
            data-state={active ? 'active' : undefined}
            className={PAGE_TAB_TRIGGER}
          >
            {label}
            {Badge && (
              <Suspense fallback={null}>
                <Badge contactId={contactId} />
              </Suspense>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function ContactNotFound() {
  return (
    <div className="flex flex-col items-start gap-2">
      <h1 className="text-xl font-semibold">Contact not found</h1>
      <p className="text-muted-foreground">It may have been deleted, or the link is wrong.</p>
      <Link to="/contacts" className="text-sm underline">Back to contacts</Link>
    </div>
  );
}

export function ContactWorkspace() {
  const { id, tab } = useParams();
  // Never query with something that is not a contact id.
  if (!isUuid(id)) return <ContactNotFound />;
  // A tab no feature registers (an old link, a feature since removed) opens the record.
  if (tab !== undefined && !contactTabs.some((t) => t.key === tab)) return <Navigate to={links.contact(id)} replace />;
  return <Workspace key={id} id={id} tab={tab ?? null} />;
}

function Workspace({ id, tab }: { id: string; tab: string | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const contact = useQuery({ queryKey: queryKeys.contacts.detail(id), queryFn: () => getContact(id) });
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const notice = (location.state as { notice?: string } | null)?.notice;

  const remove = useMutation({
    mutationFn: () => deleteContact(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.contacts.detail(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      navigate('/contacts');
    },
  });

  if (contact.isPending) return <p className="text-muted-foreground">Loading contact...</p>;
  if (contact.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="font-medium">Could not load this contact.</p>
        <p className="text-sm text-muted-foreground">{getErrorMessage(contact.error)}</p>
        <Link to="/contacts" className="text-sm underline">Back to contacts</Link>
      </div>
    );
  }
  if (!contact.data) return <ContactNotFound />;
  const c = contact.data;

  const Tab = contactTabs.find((t) => t.key === tab)?.Component;

  return (
    <div className="flex flex-col gap-4">
      <Link to="/contacts" className="text-sm underline">Back to contacts</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{contactDisplayName(c)}</h1>
          <StatusBadge statusKey={c.status} status={statusByKey.get(c.status)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {contactHeaderActions.map(({ key, Component }) => (
            <Suspense key={key} fallback={null}>
              <Component contactId={c.id} />
            </Suspense>
          ))}
          <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => setConfirmDelete(true)}>
            {remove.isPending ? 'Deleting...' : 'Delete contact'}
          </Button>
        </div>
      </div>
      {notice && <p role="status" className="text-sm text-destructive">{notice}</p>}
      {remove.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(remove.error)}</p>}

      <div className="flex gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <RecordTabs contactId={c.id} current={tab} />
          <div className="pt-2">
            {Tab ? (
              <Suspense fallback={<p className="text-[13px] text-muted-foreground">Loading...</p>}>
                <Tab contactId={c.id} />
              </Suspense>
            ) : (
              <OverviewTab contact={c} />
            )}
          </div>
        </div>
        {contactSidePanels.length > 0 && (
          <aside aria-label="Contact summary" className={`hidden shrink-0 flex-col gap-3 xl:flex ${SIDE_BAR_W}`}>
            {contactSidePanels.map(({ key, Component }) => (
              <Suspense key={key} fallback={null}>
                <Component contactId={c.id} />
              </Suspense>
            ))}
          </aside>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {contactDisplayName(c)}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the contact and everything recorded on it. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete contact</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
