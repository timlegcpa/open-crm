import { Suspense, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { contactDisplayName, deleteContact, isUuid, type Contact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { StatusBadge, StatusMonogram } from '@/components/contacts/StatusBadge';
import { SIDE_BAR_W } from '@/components/layout/page';
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
import { Button } from '@/components/ui/button';
import { CopyValue } from '@/components/ui/copy-value';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { initialsOf } from '@/components/ui/monogram';
import { PAGE_TAB_TRIGGER, PAGE_TABS_LIST } from '@/components/ui/page-tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { contactHeaderActions, contactTabs } from '@/features/registry';
import { useContact } from '@/features/crm/hooks';
import { OverviewTab } from '@/features/crm/components/OverviewTab';
import { RecordRightBar } from '@/features/crm/components/RecordRightBar';
import { getErrorMessage } from '@/lib/errors';
import { formatPhoneNumber } from '@/lib/format';

/**
 * The record's tab strip. Overview is the record itself (/contacts/:id); every other tab is
 * a feature's `contactTabs` entry at /contacts/:id/<key>, so a tab is a linkable URL and a
 * feature adds one by editing its own manifest. A tab's badge counts only what is waiting.
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
    <div className="flex flex-col items-start gap-2 p-5">
      <h1 className="text-xl font-semibold">Contact not found</h1>
      <p className="text-muted-foreground">It may have been deleted, or the link is wrong.</p>
      <Link to={links.contacts()} className="text-sm underline">Back to contacts</Link>
    </div>
  );
}

/** The contact record, nested beside the contacts index at /contacts/:id(/:tab). */
export function ContactWorkspace() {
  const { id, tab } = useParams();
  // Never query with something that is not a contact id.
  if (!isUuid(id)) return <ContactNotFound />;
  // A tab no feature registers (an old link, a feature since removed) opens the record.
  if (tab !== undefined && !contactTabs.some((t) => t.key === tab)) return <Navigate to={links.contact(id)} replace />;
  return <Workspace id={id} tab={tab ?? null} />;
}

function Workspace({ id, tab }: { id: string; tab: string | null }) {
  const { contacts, contact } = useContact(id);
  if (contacts.isPending) return <p className="p-5 text-[13px] text-muted-foreground">Loading contact...</p>;
  if (contacts.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-5">
        <p className="font-medium">Could not load this contact.</p>
        <p className="text-sm text-muted-foreground">{getErrorMessage(contacts.error)}</p>
      </div>
    );
  }
  if (!contact) return <ContactNotFound />;
  return <Record contact={contact} tab={tab} />;
}

function Record({ contact, tab }: { contact: Contact; tab: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useContactStatuses();
  const status = useByKey(statuses.data).get(contact.status);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const name = contactDisplayName(contact);

  const remove = useMutation({
    mutationFn: () => deleteContact(contact.id),
    onSuccess: () => navigate(links.contacts()),
    onError: (err) => toast.error(getErrorMessage(err, 'The contact was not deleted.')),
    // Refresh on failure too: a delete that reported an error may still have run.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });

  const Tab = contactTabs.find((t) => t.key === tab)?.Component;

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <ScrollArea className="h-full min-w-0 flex-1" fitWidth>
        <div className="flex min-w-0 flex-col gap-4 px-4 pb-6 pt-4 md:px-5">
          <header className="flex min-w-0 flex-wrap items-start gap-3.5">
            <Link
              to={links.contacts()}
              className="mt-1 flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Contacts
            </Link>
            <StatusMonogram initials={initialsOf(name)} status={status} size="lg" className="max-sm:hidden" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <h1 className="truncate text-[18px] font-semibold leading-6">{name}</h1>
                <StatusBadge statusKey={contact.status} status={status} />
              </div>
              {(contact.business_name || contact.email || contact.phone) && (
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-0.5 text-[12.5px] text-muted-foreground xl:hidden">
                  {contact.business_name && <span className="min-w-0 truncate">{contact.business_name}</span>}
                  {contact.email && <CopyValue value={contact.email} label="email" className="max-w-[220px]" />}
                  {contact.phone && <CopyValue value={formatPhoneNumber(contact.phone)} label="phone" />}
                </div>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {contactHeaderActions.map(({ key, Component }) => (
                <Suspense key={key} fallback={null}>
                  <Component contactId={contact.id} />
                </Suspense>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon-sm" aria-label="More actions">
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    disabled={remove.isPending}
                    onSelect={() => setConfirmDelete(true)}
                  >
                    {remove.isPending ? 'Deleting...' : 'Delete contact'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <RecordTabs contactId={contact.id} current={tab} />
          {Tab ? (
            <Suspense fallback={<p className="text-[13px] text-muted-foreground">Loading...</p>}>
              <Tab contactId={contact.id} />
            </Suspense>
          ) : (
            <OverviewTab contact={contact} />
          )}
        </div>
      </ScrollArea>
      <aside aria-label="Contact summary" className={`hidden shrink-0 border-l border-border xl:block ${SIDE_BAR_W}`}>
        <ScrollArea className="h-full" fitWidth>
          <div className="p-3">
            <RecordRightBar contact={contact} />
          </div>
        </ScrollArea>
      </aside>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the contact and everything recorded on it. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void remove.mutateAsync().catch(() => undefined)}
            >
              Delete contact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
