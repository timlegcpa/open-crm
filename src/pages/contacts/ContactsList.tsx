import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import {
  bulkUpdateStatus,
  contactDisplayName,
  deleteContacts,
  listContacts,
  type BulkStatusResult,
  type ContactListRow,
  type DeleteOutcome,
} from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { useByKey, useContactStatuses, useLeadSources } from '@/hooks/usePickLists';
import { StatusBadge } from '@/components/contacts/StatusBadge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
import { dateSortKey, formatDate } from '@/lib/dates';
import { getErrorMessage } from '@/lib/errors';

const ALL_STATUSES = '__all__';

type SortKey = 'name' | 'status' | 'date';

function contactDate(c: ContactListRow): string {
  return c.submitted_at ?? c.created_at;
}

function matchesSearch(c: ContactListRow, needle: string, digits: string): boolean {
  const text = [c.full_name, c.business_name, c.email, c.phone].filter(Boolean).join(' ').toLowerCase();
  if (text.includes(needle)) return true;
  return digits.length > 0 && (c.phone ?? '').replace(/\D/g, '').includes(digits);
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; ascending: boolean };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.ascending ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(sortKey)}>
        {label}
        {active && <Arrow className="h-3 w-3" aria-hidden="true" />}
      </button>
    </TableHead>
  );
}

export function ContactsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: queryKeys.contacts.list(), queryFn: listContacts });
  const statuses = useContactStatuses();
  const sources = useLeadSources();
  const statusByKey = useByKey(statuses.data);
  const sourceByKey = useByKey(sources.data);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'date', ascending: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkResult, setBulkResult] = useState<BulkStatusResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteOutcomes, setDeleteOutcomes] = useState<DeleteOutcome[] | null>(null);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const rows = (contacts.data ?? []).filter(
      (c) =>
        (statusFilter === ALL_STATUSES || c.status === statusFilter) &&
        (needle === '' || matchesSearch(c, needle, digits)),
    );
    const direction = sort.ascending ? 1 : -1;
    const compare = (a: ContactListRow, b: ContactListRow): number => {
      if (sort.key === 'name') return contactDisplayName(a).localeCompare(contactDisplayName(b));
      if (sort.key === 'status') {
        return (statusByKey.get(a.status)?.sort_order ?? 0) - (statusByKey.get(b.status)?.sort_order ?? 0);
      }
      return dateSortKey(contactDate(a)) - dateSortKey(contactDate(b));
    };
    return [...rows].sort((a, b) => compare(a, b) * direction);
  }, [contacts.data, search, statusFilter, sort, statusByKey]);

  const names = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, contactDisplayName(c)])), [contacts.data]);
  const selectedIds = [...selected];
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));

  const bulkStatusMutation = useMutation({
    mutationFn: () => bulkUpdateStatus(selectedIds, bulkStatus),
    onSuccess: (result) => setBulkResult(result),
    onError: (err) => setBulkResult({ requested: selectedIds.length, updated: 0, error: getErrorMessage(err) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: () => deleteContacts(selectedIds),
    onSuccess: (outcomes) => {
      setDeleteOutcomes(outcomes);
      const gone = new Set(outcomes.filter((o) => o.ok).map((o) => o.id));
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleAllVisible = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      visible.forEach((c) => (on ? next.add(c.id) : next.delete(c.id)));
      return next;
    });

  const onSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, ascending: !prev.ascending } : { key, ascending: key !== 'date' }));

  if (contacts.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="font-medium">Could not load contacts.</p>
        <p className="text-sm text-muted-foreground">{getErrorMessage(contacts.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void contacts.refetch()}>Try again</Button>
      </div>
    );
  }

  const failures = deleteOutcomes?.filter((o): o is Extract<DeleteOutcome, { ok: false }> => !o.ok) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Contacts</h1>
        <Button asChild size="sm">
          <Link to="/contacts/new"><Plus aria-hidden="true" />Add contact</Link>
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Search contacts"
          placeholder="Search name, email, phone or business"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-sm"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger aria-label="Filter by status" className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
            {(statuses.data ?? []).map((s) => (
              <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <span className="text-sm">{selected.size} selected</span>
          <Select value={bulkStatus} onValueChange={setBulkStatus}>
            <SelectTrigger aria-label="New status" className="w-44">
              <SelectValue placeholder="Change status to..." />
            </SelectTrigger>
            <SelectContent>
              {(statuses.data ?? []).map((s) => (
                <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={!bulkStatus || bulkStatusMutation.isPending}
            onClick={() => {
              setBulkResult(null);
              bulkStatusMutation.mutate();
            }}
          >
            Apply status
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkDeleteMutation.isPending}
            onClick={() => setConfirmDelete(true)}
          >
            {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      )}

      {bulkResult && (
        <p role="status" className="text-sm">
          {bulkResult.error
            ? `Status changed on ${bulkResult.updated} of ${bulkResult.requested} contacts. ${bulkResult.error}`
            : `Status changed on ${bulkResult.updated} of ${bulkResult.requested} contacts.`}
        </p>
      )}

      {deleteOutcomes && (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <p>Deleted {deleteOutcomes.length - failures.length} of {deleteOutcomes.length} contacts.</p>
          {failures.length > 0 && (
            <ul className="list-disc pl-5 text-destructive">
              {failures.map((f) => (
                <li key={f.id}>{names.get(f.id) ?? f.id}: {f.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {contacts.isPending ? (
        <p className="text-muted-foreground">Loading contacts...</p>
      ) : contacts.data.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-md border p-6">
          <p className="font-medium">No contacts yet.</p>
          <p className="text-sm text-muted-foreground">Add your first contact to start your pipeline.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  aria-label="Select all shown contacts"
                  checked={allVisibleSelected}
                  onCheckedChange={(v) => toggleAllVisible(v === true)}
                />
              </TableHead>
              <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
              <TableHead>Business</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
              <TableHead>Source</TableHead>
              <SortHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  No contacts match.
                </TableCell>
              </TableRow>
            )}
            {visible.map((c) => (
              <TableRow
                key={c.id}
                className="cursor-pointer"
                data-state={selected.has(c.id) ? 'selected' : undefined}
                onClick={() => navigate(`/contacts/${c.id}`)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select ${contactDisplayName(c)}`}
                    checked={selected.has(c.id)}
                    onCheckedChange={(v) => toggle(c.id, v === true)}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  <Link to={`/contacts/${c.id}`} onClick={(e) => e.stopPropagation()}>{contactDisplayName(c)}</Link>
                </TableCell>
                <TableCell>{c.business_name}</TableCell>
                <TableCell>{c.email}</TableCell>
                <TableCell>{c.phone}</TableCell>
                <TableCell><StatusBadge statusKey={c.status} status={statusByKey.get(c.status)} /></TableCell>
                <TableCell>{sourceByKey.get(c.source)?.label ?? c.source}</TableCell>
                <TableCell>{formatDate(contactDate(c))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} contacts?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected contacts and everything recorded on them. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDeleteOutcomes(null);
                bulkDeleteMutation.mutate();
              }}
            >
              Delete contacts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
