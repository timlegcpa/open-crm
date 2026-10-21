import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { bulkUpdateStatus, deleteContacts, isArchived, type Contact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { EmptyState } from '@/components/layout/page';
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
import { useByKey, useContactStatuses, useServiceTypes } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { CLIENT_PANEL_SEARCH_ID } from '@/features/types';
import { ContactIndexRow } from '@/features/crm/components/ContactIndex';
import { useContacts, useOrganizationRoster, useOrganizationsByContact } from '@/features/crm/hooks';
import { contactIdsForView, matchesCrmSearch } from '@/features/crm/lib/board';
import { contactCsvRows } from '@/features/crm/lib/csv';
import { statusInList } from '@/features/crm/lib/sections';
import { isSystemStatus } from '@/lib/contactStatus';
import { csvBlob } from '@/lib/csv';
import { downloadBlob } from '@/lib/download';
import { getErrorMessage } from '@/lib/errors';
import { todayISODate } from '@/lib/format';
import { safeStorage, storageKey } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { useWorkspaceSearch } from './search';
import { useArchiveOne } from './useArchiveOne';

type PanelScope = 'all' | 'clients';
const SCOPES = [
  { value: 'all', label: 'All' },
  { value: 'clients', label: 'Clients' },
] as const;

/** The switch's last value in this browser. Holds 'all' or 'clients', never contact data. */
export const PANEL_SCOPE_KEY = storageKey('workspace', 'panelScope');
const isScope = (value: unknown): value is PanelScope => value === 'all' || value === 'clients';

/**
 * The client panel, on every workspace screen, mounted once by the layout so it stays put
 * while the screen beside it changes. Two lists: **All** (the default) is everyone; **Clients**
 * is every paying contact, one-time clients included. Either is ONE list, A to Z by last name;
 * a row's status is its monogram's tint (and its text for a screen reader). A search looks
 * through everyone, whichever list is on, and so does a board filter (`?view=`).
 *
 * A pick opens the contact's record, except where the screen names a `pickParam`
 * (documents): there it sets that query parameter and the owner stays on the screen.
 *
 * Archived contacts are off the lists; the contacts page's Archived dialog lists them.
 * Selection (a checkbox on each row) and the bulk bar live here, over the same rows. A bulk
 * action acts on the selected rows on screen, never on one a switch or a search has hidden.
 */
export function ClientPanel({ pickParam }: { pickParam?: string }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { query, setQuery } = useWorkspaceSearch();
  const view = searchParams.get('view');
  const picked = pickParam ? searchParams.get(pickParam) : null;

  const contacts = useContacts();
  const roster = useOrganizationRoster();
  const orgsByContact = useOrganizationsByContact();
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);
  const services = useServiceTypes();
  const serviceLabels = useMemo(() => new Map((services.data ?? []).map((s) => [s.key, s.label])), [services.data]);
  const organizations = useMemo(() => roster.data ?? [], [roster.data]);
  const all = useMemo(() => (contacts.data ?? []).filter((c) => !isArchived(c)), [contacts.data]);

  const [scope, setScopeState] = useState<PanelScope>(() => safeStorage.getJson(PANEL_SCOPE_KEY, isScope) ?? 'all');
  const setScope = (next: PanelScope) => {
    setScopeState(next);
    // Another list is another set of rows: the selection was made over the old one.
    if (next !== scope) setSelected(new Set());
    // Storage may be unavailable; the switch then lasts for this visit.
    safeStorage.setJson(PANEL_SCOPE_KEY, next);
  };

  // THE one matcher and THE one view resolver, shared with the board and the table.
  const matches = useCallback((c: Contact) => matchesCrmSearch(c, orgsByContact.get(c.id) ?? [], query), [orgsByContact, query]);
  const viewIds = useMemo(() => contactIdsForView(view, all, { serviceLabels, organizations }), [view, all, serviceLabels, organizations]);
  const filtering = query.trim() !== '' || view !== null;
  const rows = useMemo(
    () =>
      all
        .filter((c) => (!viewIds || viewIds.has(c.id)) && matches(c) && (filtering || scope === 'all' || statusInList(c.status, 'clients')))
        .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) || a.id.localeCompare(b.id)),
    [all, viewIds, matches, filtering, scope],
  );
  const visible = rows.length;

  const statusLabel = useCallback((key: string) => statusByKey.get(key)?.label ?? key, [statusByKey]);
  const businessOf = useCallback((c: Contact) => orgsByContact.get(c.id)?.[0]?.name ?? c.business_name ?? '', [orgsByContact]);

  // ── Selection and the bulk bar ──────────────────────────────────
  const [selected, setSelectedState] = useState<ReadonlySet<string>>(new Set());
  // Bumped by every change to the selection. A bulk action notes it when it starts and puts
  // its result into the selection only if it is unchanged when the server answers: by then
  // the owner may have cleared, switched list or screen, and picked someone else.
  const generation = useRef(0);
  const setSelected = useCallback((next: SetStateAction<ReadonlySet<string>>) => {
    generation.current += 1;
    setSelectedState(next);
  }, []);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { archiveOne, pending: archiving, setArchived } = useArchiveOne();
  // What a bulk action acts on: the selected rows on screen. A search can hide a selected
  // row for a moment; it stays selected, but nothing is done to it while it is out of view.
  const targets = useMemo(() => rows.filter((c) => selected.has(c.id)).map((c) => c.id), [rows, selected]);
  const selecting = targets.length > 0;
  // A selection belongs to the screen it was made on: moving to another screen (the board,
  // documents) clears it. A tab of the same screen keeps it, and so does a tab redirect.
  const screen = location.pathname.split('/')[1] ?? '';
  useEffect(() => setSelected(new Set()), [screen, setSelected]);

  /** After a bulk action: `next` becomes the selection, unless it changed while the action ran. */
  const settle = (startedAt: number, next: Iterable<string>) => {
    if (generation.current !== startedAt) return false;
    setSelected(new Set(next));
    return true;
  };

  const toggleSelect = (contactId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });

  const applyStatus = async () => {
    if (!bulkStatus || bulkBusy) return;
    setBulkBusy(true);
    const startedAt = generation.current;
    try {
      const result = await bulkUpdateStatus(targets, bulkStatus);
      if (result.error) {
        toast.error(`Status changed on ${result.updated} of ${result.requested} contacts. ${result.error}`);
        // Failures stay selected, so they can be tried again.
        settle(startedAt, result.failedIds);
      } else {
        toast.success(`Status changed on ${result.updated} of ${result.requested} contacts.`);
        if (settle(startedAt, [])) setBulkStatus('');
      }
    } finally {
      setBulkBusy(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    }
  };

  const archiveSelected = async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    const startedAt = generation.current;
    try {
      const result = await setArchived.run(targets, true);
      // Failures stay selected, so they can be tried again.
      settle(startedAt, result.failedIds);
    } finally {
      setBulkBusy(false);
    }
  };

  const deleteSelected = async () => {
    setConfirmDelete(false);
    setBulkBusy(true);
    const startedAt = generation.current;
    try {
      const outcomes = await deleteContacts(targets);
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
      settle(startedAt, failed.map((f) => f.id));
    } finally {
      setBulkBusy(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    }
  };

  const exportSelected = () => {
    const chosen = rows.filter((c) => selected.has(c.id));
    downloadBlob(csvBlob(contactCsvRows(chosen, { businessOf, statusLabel })), `contacts-selected-${todayISODate()}.csv`);
  };

  /** Where a row goes: the record, or this screen with the contact picked. */
  const pickTo = (contactId: string) => {
    if (!pickParam) return undefined;
    const next = new URLSearchParams(searchParams);
    next.set(pickParam, contactId);
    return `${location.pathname}?${next}`;
  };
  // The record link keeps the board filter, so the index beside the record keeps its rows.
  const recordSearch = view ? `?view=${encodeURIComponent(view)}` : '';

  let body: ReactNode;
  if (contacts.isPending) body = <p className="px-3 py-4 text-[13px] text-muted-foreground">Loading contacts...</p>;
  else if (contacts.isError) {
    body = (
      <div role="alert" className="px-3 py-4 text-[13px]">
        <p className="font-medium">Could not load contacts.</p>
        <p className="text-muted-foreground">{getErrorMessage(contacts.error)}</p>
      </div>
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        title="No contacts yet."
        description="Add the first one to start the pipeline."
        action={
          <Button asChild size="sm">
            <Link to={links.newContact()}>Add contact</Link>
          </Button>
        }
      />
    );
  } else if (rows.length === 0) {
    body = <p className="px-3 py-4 text-[13px] text-muted-foreground">{filtering ? 'No contacts match.' : 'No clients yet.'}</p>;
  } else {
    body = (
      <ul className="pt-1">
        {rows.map((c) => (
          <ContactIndexRow
            key={c.id}
            contact={c}
            status={statusByKey.get(c.status)}
            statusLabel={statusLabel(c.status)}
            selected={selected.has(c.id)}
            selecting={selecting}
            onToggleSelect={toggleSelect}
            search={recordSearch}
            to={pickTo(c.id)}
            current={pickParam ? picked === c.id : undefined}
            onArchive={(contact) => void archiveOne(contact, true)}
            archiving={archiving.has(c.id)}
          />
        ))}
      </ul>
    );
  }

  const selectableStatuses = (statuses.data ?? []).filter((s) => !isSystemStatus(s.key));
  const countText = filtering
    ? `${visible} found`
    : scope === 'all'
      ? `${visible} ${visible === 1 ? 'contact' : 'contacts'}`
      : `${visible} ${visible === 1 ? 'client' : 'clients'}`;

  return (
    <aside aria-label="Contact list" className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card">
      {/* 48px: level with the tab strip beside it. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate text-[12px] tabular-nums text-muted-foreground">{contacts.data ? countText : ''}</p>
        <Segmented label="Which contacts" value={scope} onValueChange={setScope} options={SCOPES} />
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id={CLIENT_PANEL_SEARCH_ID}
            aria-label="Search contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        {view && <ViewFilterChip />}
      </div>
      <ScrollArea className="min-h-0 flex-1" fitWidth>
        <div className={cn('pb-3', selecting && 'pb-36')}>{body}</div>
      </ScrollArea>
      {selecting && (
        <div role="region" aria-label="Selected contacts" className="absolute inset-x-2 bottom-2 flex flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-[13px] shadow-lg">
          <div className="flex items-center justify-between">
            <span className="font-medium">{targets.length} selected</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger aria-label="New status" className="h-7 min-w-0 flex-1 text-[12px]">
                <SelectValue placeholder="Change status" />
              </SelectTrigger>
              <SelectContent>
                {selectableStatuses.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" size="xs" disabled={!bulkStatus || bulkBusy} onClick={() => void applyStatus()}>
              Apply status
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {bulkBusy ? (
              <Button type="button" size="xs" variant="outline" disabled>
                Email them
              </Button>
            ) : (
              <Button asChild size="xs" variant="outline">
                <Link to={links.newGroupEmail(targets)}>Email them</Link>
              </Button>
            )}
            <Button type="button" size="xs" variant="outline" disabled={bulkBusy} onClick={exportSelected}>
              Export CSV
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={bulkBusy} onClick={() => void archiveSelected()}>
              Archive
            </Button>
            <Button type="button" size="xs" variant="outline" className="text-destructive" disabled={bulkBusy} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {targets.length} contacts?</AlertDialogTitle>
            <AlertDialogDescription>Each contact is deleted with everything recorded on it. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void deleteSelected()}>
              Delete contacts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

/** Says the list is narrowed by a board figure (`?view=`), and clears it. */
export function ViewFilterChip() {
  const [searchParams, setSearchParams] = useSearchParams();
  const clear = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    setSearchParams(next, { replace: true });
  };
  return (
    <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
      Filtered by the board
      <ClickRegion onClick={clear} aria-label="Clear list filter" className="inline-flex rounded-sm p-0.5 hover:bg-muted">
        <X className="h-3 w-3" aria-hidden="true" />
      </ClickRegion>
    </div>
  );
}
