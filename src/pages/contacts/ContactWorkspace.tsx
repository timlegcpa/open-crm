import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactDisplayName, deleteContact, getContact, isUuid, type Contact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { StatusBadge } from '@/components/contacts/StatusBadge';
import { ContactFieldsForm } from '@/components/contacts/ContactFieldsForm';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';
import { ContactNotesPanel } from '@/components/contacts/ContactNotesPanel';
import { HouseholdPanel } from '@/components/contacts/HouseholdPanel';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

/** The workspace tabs. Activity, Billing and the rest are one entry each. */
const TABS: Array<{ value: string; label: string; render: (contact: Contact) => ReactNode }> = [
  { value: 'overview', label: 'Overview', render: (contact) => <OverviewTab contact={contact} /> },
];

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
  const { id } = useParams();
  // Never query with something that is not a contact id.
  if (!isUuid(id)) return <ContactNotFound />;
  return <Workspace key={id} id={id} />;
}

function Workspace({ id }: { id: string }) {
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

  return (
    <div className="flex flex-col gap-4">
      <Link to="/contacts" className="text-sm underline">Back to contacts</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{contactDisplayName(c)}</h1>
          <StatusBadge statusKey={c.status} status={statusByKey.get(c.status)} />
        </div>
        <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => setConfirmDelete(true)}>
          {remove.isPending ? 'Deleting...' : 'Delete contact'}
        </Button>
      </div>
      {notice && <p role="status" className="text-sm text-destructive">{notice}</p>}
      {remove.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(remove.error)}</p>}

      <Tabs defaultValue={TABS[0].value}>
        <TabsList>
          {TABS.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="pt-2">
            {t.render(c)}
          </TabsContent>
        ))}
      </Tabs>

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
