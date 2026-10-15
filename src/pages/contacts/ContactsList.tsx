import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Download, LayoutList, Plus, Search, Table2, X } from 'lucide-react';
import { bulkUpdateStatus, deleteContacts, type Contact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { EmptyState, PageHeader } from '@/components/layout/page';
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
import { ClickRegion } from '@/components/ui/click-region';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Toggle } from '@/components/ui/toggle';
import { useCollapsedSections } from '@/hooks/useCollapsedSections';
import { useByKey, useContactStatuses, useServiceTypes } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { CrmBoard } from '@/features/crm/components/board/CrmBoard';
import { ContactIndexGroup, ContactIndexRow } from '@/features/crm/components/ContactIndex';
import { CrmTable, tableMrrOf } from '@/features/crm/components/CrmTable';
import { useContacts, useOrganizationRoster, useOrganizationsByContact, useUpdateContact } from '@/features/crm/hooks';
import { contactIdsForView, cadenceText, matchesCrmSearch, pipelineFigures, unsignedWork } from '@/features/crm/lib/board';
import { contactCsvRows } from '@/features/crm/lib/csv';
import { quoteOpMutationKey, statusChangePatch } from '@/features/crm/lib/quotes';
import { bucketBySection, CRM_LISTS, statusInList, type CrmListKey } from '@/features/crm/lib/sections';
import { crmTableRows, DEFAULT_CRM_TABLE_FILTERS, type CrmTableFilters } from '@/features/crm/lib/table';
import { CRM_COLLAPSED_KEY, useCrmLayout, useCrmList } from '@/features/crm/prefs';
import { useWide } from '@/features/crm/useWide';
import { isSystemStatus } from '@/lib/contactStatus';
import { csvBlob } from '@/lib/csv';
import { downloadBlob } from '@/lib/download';
import { getErrorMessage } from '@/lib/errors';
import { todayISODate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The contacts page: a fixed 300px index of sections beside the record (nested with
 * <Outlet key={id}>), or, with no record open, the pipeline board or the Table view.
 */
export function ContactsList() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view');
  const [search, setSearch] = useState('');

  const contacts = useContacts();
  const roster = useOrganizationRoster();
  const orgsByContact = useOrganizationsByContact();
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);
  const services = useServiceTypes();
  const serviceLabels = useMemo(() => new Map((services.data ?? []).map((s) => [s.key, s.label])), [services.data]);
  const organizations = useMemo(() => roster.data ?? [], [roster.data]);
  const all = useMemo(() => contacts.data ?? [], [contacts.data]);

  const [list, setList] = useCrmList();
  const [layout, setLayout] = useCrmLayout();
  const { collapsed, toggle } = useCollapsedSections(CRM_COLLAPSED_KEY);
  const [tableFilters, setTableFilters] = useState<CrmTableFilters>(DEFAULT_CRM_TABLE_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selecting = selected.size > 0;

  const statusLabel = useCallback((key: string) => statusByKey.get(key)?.label ?? key, [statusByKey]);
  /** An organization's name first, else the free-text business on the contact. */
  const businessOf = useCallback((c: Contact) => orgsByContact.get(c.id)?.[0]?.name ?? c.business_name ?? '', [orgsByContact]);

  // THE one matcher and THE one view resolver, for the index, the board and the table.
  const matches = useCallback((c: Contact) => matchesCrmSearch(c, orgsByContact.get(c.id) ?? [], search), [orgsByContact, search]);
  const viewIds = useMemo(() => contactIdsForView(view, all, { serviceLabels, organizations }), [view, all, serviceLabels, organizations]);
  const inView = useMemo(() => all.filter((c) => (!viewIds || viewIds.has(c.id)) && matches(c)), [all, viewIds, matches]);
  // The list switch applies only with no view and no search.
  const listApplies = !view && search.trim() === '';
  const indexRows = useMemo(() => (listApplies ? inView.filter((c) => statusInList(c.status, list)) : inView), [inView, listApplies, list]);
  const sections = useMemo(() => bucketBySection(indexRows, statusByKey).filter((s) => s.rows.length > 0), [indexRows, statusByKey]);
  const figures = useMemo(() => pipelineFigures(unsignedWork(all, { serviceLabels, organizations })), [all, serviceLabels, organizations]);

  const indexSearch = view ? `?view=${encodeURIComponent(view)}` : '';
  const recordOpen = id !== undefined;
  const wide = useWide();

  const setView = (next: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('view', next);
    else params.delete('view');
    setSearchParams(params, { replace: true });
  };

  const toggleSelect = (contactId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });

  // ── Stage moves ─────────────────────────────────────────────────
  const update = useUpdateContact();
  const movingRef = useRef(new Set<string>());
  /** One move per contact at a time, and never while a quote for it is saving. */
  const moveStage = async (contactId: string, status: string) => {
    const contact = all.find((c) => c.id === contactId);
    if (!contact || contact.status === status || movingRef.current.has(contactId)) return;
    if (queryClient.isMutating({ mutationKey: quoteOpMutationKey(contactId) }) > 0) {
      toast('A quote for this contact is still saving. Try again in a moment.');
      return;
    }
    movingRef.current.add(contactId);
    try {
      await update.mutateAsync({ id: contactId, patch: statusChangePatch(status) });
    } catch (err) {
      toast.error(getErrorMessage(err, 'The stage was not changed.'));
    } finally {
      movingRef.current.delete(contactId);
    }
  };

  // ── Bulk ────────────────────────────────────────────────────────
  const selectedContacts = all.filter((c) => selected.has(c.id));

  const applyStatus = async () => {
    if (!bulkStatus || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await bulkUpdateStatus([...selected], bulkStatus);
      if (result.error) {
        toast.error(`Status changed on ${result.updated} of ${result.requested} contacts. ${result.error}`);
        // Failures stay selected, so they can be tried again.
        setSelected(new Set(result.failedIds));
      } else {
        toast.success(`Status changed on ${result.updated} of ${result.requested} contacts.`);
        setSelected(new Set());
        setBulkStatus('');
      }
    } finally {
      setBulkBusy(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    }
  };

  const deleteSelected = async () => {
    setConfirmDelete(false);
    setBulkBusy(true);
    try {
      const outcomes = await deleteContacts([...selected]);
      const failed = outcomes.filter((o) => !o.ok);
      const done = outcomes.length - failed.length;
      const names = new Map(all.map((c) => [c.id, c.full_name || c.business_name || 'Unnamed contact']));
      if (failed.length === 0) toast.success(`Deleted ${done} of ${outcomes.length} contacts.`);
      else {
        toast.error(`Deleted ${done} of ${outcomes.length} contacts.`, {
          description: failed.map((f) => `${names.get(f.id)}: ${'error' in f ? f.error : ''}`).join(' '),
        });
      }
      // Failures stay selected, so they can be tried again.
      setSelected(new Set(failed.map((f) => f.id)));
    } finally {
      setBulkBusy(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    }
  };

  const exportCsv = (rows: readonly Contact[], name: string) => {
    downloadBlob(csvBlob(contactCsvRows(rows, { businessOf, statusLabel })), `${name}-${todayISODate()}.csv`);
  };

  const switchList = (next: CrmListKey) => {
    setList(next);
    setSelected(new Set());
  };

  const today = useMemo(() => new Date(), []);
  // The board and the table live only on wide screens (useWide), so the Layout switch and
  // the table's export are offered only there.
  const showTable = wide && !recordOpen && layout === 'table';

  const headerActions = (
    <>
      {wide && !recordOpen && (
        <Segmented
          label="Layout"
          value={layout}
          onValueChange={setLayout}
          options={[
            { value: 'list', label: <><LayoutList aria-hidden="true" />List</> },
            { value: 'table', label: <><Table2 aria-hidden="true" />Table</> },
          ]}
        />
      )}
      {figures.length > 0 && (
        <div className="hidden items-center gap-1 min-[1400px]:flex">
          {figures.map((f) => (
            <Toggle
              key={f.key}
              size="sm"
              pressed={view === f.key}
              onPressedChange={(on) => setView(on ? f.key : null)}
              aria-label={`${f.label}: ${cadenceText(f) || 'no price yet'}`}
              className="h-7 gap-1.5 px-2 text-[12px]"
            >
              <span className="text-muted-foreground">{f.label}</span>
              <span className="font-semibold tabular-nums">{cadenceText(f) || `${f.people} unpriced`}</span>
            </Toggle>
          ))}
        </div>
      )}
      {showTable && (
        <Button type="button" size="sm" variant="outline" onClick={() => exportCsv(crmTableRows(inView, tableFilters, { today, mrrOf: tableMrrOf }), 'contacts')}>
          <Download aria-hidden="true" />
          Export CSV
        </Button>
      )}
      <Button asChild size="sm">
        <Link to={links.newContact()}>
          <Plus aria-hidden="true" />
          Add contact
        </Link>
      </Button>
    </>
  );

  let indexBody: ReactNode;
  if (contacts.isPending) indexBody = <p className="px-3 py-4 text-[13px] text-muted-foreground">Loading contacts...</p>;
  else if (contacts.isError) {
    indexBody = (
      <div role="alert" className="px-3 py-4 text-[13px]">
        <p className="font-medium">Could not load contacts.</p>
        <p className="text-muted-foreground">{getErrorMessage(contacts.error)}</p>
      </div>
    );
  } else if (all.length === 0) {
    indexBody = <EmptyState title="No contacts yet." description="Add the first one to start the pipeline." action={<Button asChild size="sm"><Link to={links.newContact()}>Add contact</Link></Button>} />;
  } else if (sections.length === 0) indexBody = <p className="px-3 py-4 text-[13px] text-muted-foreground">No contacts match.</p>;
  else {
    const filtering = !listApplies;
    indexBody = sections.map((s) => (
      <ContactIndexGroup
        key={s.status}
        section={s}
        label={statusLabel(s.status)}
        count={s.rows.length}
        collapsed={!filtering && !!s.collapsible && (collapsed[s.status] ?? true)}
        onToggle={() => toggle(s.status)}
      >
        {s.rows.map((c) => (
          <ContactIndexRow
            key={c.id}
            contact={c}
            status={statusByKey.get(c.status)}
            selected={selected.has(c.id)}
            selecting={selecting}
            onToggleSelect={toggleSelect}
            search={indexSearch}
          />
        ))}
      </ContactIndexGroup>
    ));
  }

  const selectableStatuses = (statuses.data ?? []).filter((s) => !isSystemStatus(s.key));

  return (
    <>
      <PageHeader title="Contacts" subtitle={contacts.data ? `${all.length} contacts` : undefined} actions={headerActions} />
      <div className="flex h-full min-h-0 flex-1">
        <div className={cn('relative flex min-h-0 shrink-0 flex-col border-r border-border', 'w-full lg:w-[300px]', recordOpen && 'max-lg:hidden')}>
          <div className="flex flex-col gap-2 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-8 pl-8 text-[13px]" />
            </div>
            <Segmented<CrmListKey>
              label="List"
              value={list}
              onValueChange={switchList}
              options={CRM_LISTS.map((l) => ({ value: l.key, label: l.label, disabled: bulkBusy || !listApplies }))}
            />
            {view && (
              <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
                Filtered by the board
                <ClickRegion onClick={() => setView(null)} aria-label="Clear list filter" className="inline-flex rounded-sm p-0.5 hover:bg-muted">
                  <X className="h-3 w-3" aria-hidden="true" />
                </ClickRegion>
              </div>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1" fitWidth>
            <div className={cn('pb-3', selecting && 'pb-36')}>{indexBody}</div>
          </ScrollArea>
          {selecting && (
            <div role="region" aria-label="Selected contacts" className="absolute inset-x-2 bottom-2 flex flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-[13px] shadow-lg">
              <div className="flex items-center justify-between">
                <span className="font-medium">{selected.size} selected</span>
                <Button type="button" size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Select value={bulkStatus} onValueChange={setBulkStatus}>
                  <SelectTrigger aria-label="New status" className="h-7 min-w-0 flex-1 text-[12px]"><SelectValue placeholder="Change status" /></SelectTrigger>
                  <SelectContent>
                    {selectableStatuses.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button type="button" size="xs" disabled={!bulkStatus || bulkBusy} onClick={() => void applyStatus()}>Apply status</Button>
              </div>
              <div className="flex items-center gap-1.5">
                {bulkBusy ? (
                  <Button type="button" size="xs" variant="outline" disabled>Email them</Button>
                ) : (
                  <Button asChild size="xs" variant="outline">
                    <Link to={links.newGroupEmail([...selected])}>Email them</Link>
                  </Button>
                )}
                <Button type="button" size="xs" variant="outline" disabled={bulkBusy} onClick={() => exportCsv(selectedContacts, 'contacts-selected')}>
                  Export CSV
                </Button>
                <Button type="button" size="xs" variant="outline" className="text-destructive" disabled={bulkBusy} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1', !recordOpen && 'max-lg:hidden')}>
          {recordOpen ? (
            <Outlet key={id} />
          ) : !wide ? null : showTable ? (
            <CrmTable
              contacts={inView}
              total={all.length}
              filters={tableFilters}
              onFilters={setTableFilters}
              statuses={statuses.data ?? []}
              businessOf={businessOf}
              today={today}
            />
          ) : (
            <CrmBoard
              contacts={all}
              organizations={organizations}
              serviceLabels={serviceLabels}
              statusByKey={statusByKey}
              search={search}
              onSearch={setSearch}
              matches={matches}
              view={view}
              onView={setView}
              loading={contacts.isPending}
              onMoveStage={moveStage}
            />
          )}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} contacts?</AlertDialogTitle>
            <AlertDialogDescription>
              Each contact is deleted with everything recorded on it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void deleteSelected()}>
              Delete contacts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
