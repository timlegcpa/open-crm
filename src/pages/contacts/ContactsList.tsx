import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Plus, Search } from 'lucide-react';
import { isArchived, type Contact } from '@/api/contacts';
import { PageHeader } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { Toggle } from '@/components/ui/toggle';
import { useByKey, useContactStatuses, useServiceTypes } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { ArchivedPeopleDialog } from '@/features/crm/components/ArchivedPeopleDialog';
import { CrmBoard } from '@/features/crm/components/board/CrmBoard';
import { CrmTable, tableMrrOf } from '@/features/crm/components/CrmTable';
import { TierBoard } from '@/features/crm/components/TierBoard';
import { useContacts, useOrganizationRoster, useOrganizationsByContact, useUpdateContact } from '@/features/crm/hooks';
import { contactIdsForView, cadenceText, matchesCrmSearch, pipelineFigures, unsignedWork } from '@/features/crm/lib/board';
import { contactCsvRows } from '@/features/crm/lib/csv';
import { quoteOpMutationKey, statusChangePatch } from '@/features/crm/lib/quotes';
import { crmTab, isCrmTabKey, resolveCrmTab, type CrmTabKey } from '@/features/crm/lib/sections';
import { crmTableRows, DEFAULT_CRM_TABLE_FILTERS, type CrmTableFilters } from '@/features/crm/lib/table';
import { rememberCrmTab, storedCrmTab } from '@/features/crm/prefs';
import { useWide } from '@/features/crm/useWide';
import { ViewFilterChip } from '@/features/workspace/ClientPanel';
import { useWorkspaceSearch } from '@/features/workspace/search';
import { useArchiveOne } from '@/features/workspace/useArchiveOne';
import { csvBlob } from '@/lib/csv';
import { downloadBlob } from '@/lib/download';
import { getErrorMessage } from '@/lib/errors';
import { todayISODate } from '@/lib/format';

/**
 * The contacts page, a workspace screen: the record (nested with <Outlet key={id}>), or,
 * with no record open, the tab's pane: the pipeline board, the tier rows or the table. The
 * tabs are the workspace strip's (Pipeline, Tiers, Table, each `?tab=`), and the index of
 * contacts is the workspace's client panel; its search narrows the board, the tiers and
 * the table here too. A bare /contacts opens the remembered tab, by a redirect, so the URL
 * always names the tab the strip marks.
 *
 * Archived contacts are off every list here (the board, the table, the tiers and a search);
 * the Archived dialog lists them, and their record still opens by link.
 */
export function ContactsList() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view');
  const { query: search, setQuery: setSearch } = useWorkspaceSearch();

  const contacts = useContacts();
  const roster = useOrganizationRoster();
  const orgsByContact = useOrganizationsByContact();
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);
  const services = useServiceTypes();
  const serviceLabels = useMemo(() => new Map((services.data ?? []).map((s) => [s.key, s.label])), [services.data]);
  const organizations = useMemo(() => roster.data ?? [], [roster.data]);
  const everyone = useMemo(() => contacts.data ?? [], [contacts.data]);
  // The working set: everyone not archived. Every list, count and figure below reads this.
  const all = useMemo(() => everyone.filter((c) => !isArchived(c)), [everyone]);
  const archived = useMemo(() => everyone.filter(isArchived), [everyone]);

  // The tab: an explicit ?tab= wins and is remembered; a bare URL (a record's own links,
  // the back link) reads the remembered one, on every render.
  const tabParam = searchParams.get('tab');
  const tab: CrmTabKey = resolveCrmTab(tabParam, storedCrmTab());
  const { pane } = crmTab(tab);
  const recordOpen = id !== undefined;
  useEffect(() => {
    if (isCrmTabKey(tabParam)) rememberCrmTab(tabParam);
  }, [tabParam]);
  // With no record open, the URL names the tab: the strip marks it and the phone's one-pane
  // rule reads it. Replaced, so Back never lands on the bare address again.
  useEffect(() => {
    if (recordOpen || tabParam === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  }, [recordOpen, tabParam, tab, searchParams, setSearchParams]);
  const [tableFilters, setTableFilters] = useState<CrmTableFilters>(DEFAULT_CRM_TABLE_FILTERS);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { archiveOne, pending: archivingIds } = useArchiveOne();

  const statusLabel = useCallback((key: string) => statusByKey.get(key)?.label ?? key, [statusByKey]);
  /** An organization's name first, else the free-text business on the contact. */
  const businessOf = useCallback((c: Contact) => orgsByContact.get(c.id)?.[0]?.name ?? c.business_name ?? '', [orgsByContact]);

  // THE one matcher and THE one view resolver, for the index, the board and the table.
  const matches = useCallback((c: Contact) => matchesCrmSearch(c, orgsByContact.get(c.id) ?? [], search), [orgsByContact, search]);
  const viewIds = useMemo(() => contactIdsForView(view, all, { serviceLabels, organizations }), [view, all, serviceLabels, organizations]);
  const inView = useMemo(() => all.filter((c) => (!viewIds || viewIds.has(c.id)) && matches(c)), [all, viewIds, matches]);
  const figures = useMemo(() => pipelineFigures(unsignedWork(all, { serviceLabels, organizations })), [all, serviceLabels, organizations]);

  const indexSearch = view ? `?view=${encodeURIComponent(view)}` : '';
  // The tier rows are the Tiers tab's whole point, so they show on a phone too (the
  // workspace's one-pane rule); the board and the table live on wide screens only.
  const wide = useWide();

  const setView = (next: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('view', next);
    else params.delete('view');
    setSearchParams(params, { replace: true });
  };

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

  /** A tier set by a drop on the Tiers tab. Rejects on failure, after saying so. */
  const saveTier = async (contactId: string, tier: string | null) => {
    try {
      await update.mutateAsync({ id: contactId, patch: { tier } });
    } catch (err) {
      toast.error(getErrorMessage(err, 'The tier was not saved.'));
      throw err;
    }
  };

  const exportCsv = (rows: readonly Contact[], name: string) => {
    downloadBlob(csvBlob(contactCsvRows(rows, { businessOf, statusLabel })), `${name}-${todayISODate()}.csv`);
  };

  const today = useMemo(() => new Date(), []);
  // The table lives only on wide screens (useWide), so its export is offered only there.
  const showTable = wide && !recordOpen && pane === 'table';
  // The tier rows read the board filter and the search, like the index beside them.
  const tierMatches = useCallback((c: Contact) => (!viewIds || viewIds.has(c.id)) && matches(c), [viewIds, matches]);

  // The search and the board filter live atop the client panel. On a narrow Tiers tab the
  // panel is hidden, yet both still narrow the tier rows, so there they sit atop the rows.
  const filtersOnTiers = pane === 'tiers' && !recordOpen && !wide;
  const filterBar = (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input aria-label="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-8 pl-8 text-[13px]" />
      </div>
      {view && <ViewFilterChip />}
    </div>
  );

  const headerActions = (
    <>
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
      <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setArchivedOpen(true)}>
        <Archive aria-hidden="true" />
        Archived ({archived.length})
      </Button>
      <Button asChild size="sm">
        <Link to={links.newContact()}>
          <Plus aria-hidden="true" />
          Add contact
        </Link>
      </Button>
    </>
  );

  return (
    <>
      <PageHeader title="Contacts" subtitle={contacts.data ? `${all.length} contacts` : undefined} actions={headerActions} />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {recordOpen ? (
          <Outlet key={id} />
        ) : pane === 'tiers' ? (
          contacts.isPending ? (
            <p className="p-5 text-[13px] text-muted-foreground">Loading contacts...</p>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {filtersOnTiers && filterBar}
              <div className="min-h-0 flex-1">
                <TierBoard
                  contacts={all}
                  matches={tierMatches}
                  onSaveTier={saveTier}
                  onOpen={(contactId) => navigate(`${links.contact(contactId)}${indexSearch}`)}
                />
              </div>
            </div>
          )
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
            onArchive={(contact) => archiveOne(contact, true)}
            archivingIds={archivingIds}
          />
        )}
      </div>

      <ArchivedPeopleDialog
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        contacts={archived}
        organizationsOf={(contactId) => orgsByContact.get(contactId) ?? []}
        statusLabel={statusLabel}
        onRestore={(contact) => void archiveOne(contact, false)}
        restoringIds={archivingIds}
      />
    </>
  );
}
