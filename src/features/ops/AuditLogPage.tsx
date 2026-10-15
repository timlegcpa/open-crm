import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { EmptyState, PAGE, PageHeader, Surface } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { PageTabsList, PageTabsTrigger } from '@/components/ui/page-tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { ToneBadge } from '@/components/ui/tone-badge';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  contactIdsOf,
  getPeople,
  listAuditLog,
  listPortalActivity,
  NO_AUDIT_FILTERS,
  opsKeys,
  type ActivityRow,
  type AuditFilters,
  type AuditRow,
  type People,
} from './api';
import { ACTIVITY_ACTION_LABELS, AUDIT_ACTION_LABELS, actionLabel } from './labels';
import { Pager } from './Pager';

type Tab = 'owner' | 'portal';
const ALL_ACTIONS = '__all__';

/** Who did it, from ids alone: the owner, the system actor, or another account. */
export function actorLabel(userId: string, people: People | undefined): string {
  if (people?.ownerUserId === userId) return 'You';
  if (people?.systemUserId === userId) return 'Automatic';
  return `Account ${userId.slice(0, 8)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^(?=[a-z0-9_.:-]*[a-z])[a-z0-9_.:-]{1,64}$/;

/**
 * A detail value as shown: an id, a number, a flag or a lowercase code (the only shapes the
 * server's audit writer accepts), or a list of those. Anything else (a name, an address,
 * free text a writer slipped in) is not shown at all.
 */
export function shownDetail(value: unknown): string | null {
  const one = (v: unknown): string | null => {
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
    if (typeof v === 'string' && (UUID.test(v) || CODE.test(v))) return v;
    return null;
  };
  if (Array.isArray(value)) {
    const parts = value.map(one);
    return parts.every((p) => p !== null) ? parts.join(', ') : null;
  }
  return one(value);
}

/**
 * A row's details as short key / value chips. A contact id becomes the contact's name from
 * the contacts table; a name is never read from the details themselves.
 */
function DetailChips({ details, people }: { details: Record<string, unknown>; people: People | undefined }) {
  const entries = Object.entries(details)
    .filter(([key]) => key !== 'source' && key !== 'actor_role')
    .map(([key, value]) => [key, value, shownDetail(value)] as const)
    .filter(([, , shown]) => shown !== null);
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([key, value, shown]) => {
        const contactName = key === 'contact_id' && typeof value === 'string' ? people?.contacts.get(value) : undefined;
        return (
          <span key={key} className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
            <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
            {contactName ? (
              <Link to={`/contacts/${value as string}`} className="truncate text-link underline-offset-2 hover:underline">{contactName}</Link>
            ) : (
              <span className="truncate font-mono">{shown}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function ContactLink({ id, people }: { id: string; people: People | undefined }) {
  const name = people?.contacts.get(id);
  return name ? (
    <Link to={`/contacts/${id}`} className="text-link underline-offset-2 hover:underline">{name}</Link>
  ) : (
    <span className="text-muted-foreground">A deleted contact</span>
  );
}

function Filters({ filters, onChange, labels }: { filters: AuditFilters; onChange: (f: AuditFilters) => void; labels: Record<string, string> }) {
  const actions = useMemo(() => Object.entries(labels).sort((a, b) => a[1].localeCompare(b[1])), [labels]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-from" className="text-xs text-muted-foreground">From</Label>
        <DatePicker id="audit-from" value={filters.from} onChange={(from) => onChange({ ...filters, from })} className="w-40" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-to" className="text-xs text-muted-foreground">To</Label>
        <DatePicker id="audit-to" value={filters.to} onChange={(to) => onChange({ ...filters, to })} className="w-40" />
      </div>
      <Select value={filters.action || ALL_ACTIONS} onValueChange={(v) => onChange({ ...filters, action: v === ALL_ACTIONS ? '' : v })}>
        <SelectTrigger aria-label="Filter by action" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_ACTIONS}>Every action</SelectItem>
          {actions.map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(filters.from || filters.to || filters.action) && (
        <Button variant="ghost" size="sm" onClick={() => onChange(NO_AUDIT_FILTERS)}>Clear filters</Button>
      )}
    </div>
  );
}

function usePeople(rows: ReadonlyArray<{ contact_id?: string; details: Record<string, unknown> }>) {
  const ids = contactIdsOf(rows);
  return useQuery({ queryKey: opsKeys.people(ids), queryFn: () => getPeople(ids) }).data;
}

function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p className="text-sm font-medium">Could not load the log.</p>
      <p className="text-sm text-muted-foreground">{getErrorMessage(error)}</p>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
    </div>
  );
}

function OwnerLog({ filters, page, onPage }: { filters: AuditFilters; page: number; onPage: (p: number) => void }) {
  const log = useQuery({ queryKey: opsKeys.audit(filters, page), queryFn: () => listAuditLog(filters, page) });
  const rows: AuditRow[] = log.data?.rows ?? [];
  const people = usePeople(rows);
  const showIp = rows.some((r) => r.ip_address);

  if (log.isError) return <Failed error={log.error} retry={() => void log.refetch()} />;
  if (log.isPending) return <p className="text-sm text-muted-foreground">Loading the log...</p>;
  if (rows.length === 0) {
    return <Surface><EmptyState icon={<ShieldCheck />} title="Nothing recorded" description="Sign-ins, security changes and deletions appear here." /></Surface>;
  }
  return (
    <>
      <Surface padding={false}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Details</TableHead>
              {showIp && <TableHead>Address</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">{formatDateTime(row.created_at)}</TableCell>
                <TableCell className="whitespace-nowrap">{actorLabel(row.user_id, people)}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {actionLabel(AUDIT_ACTION_LABELS, row.action)}
                    {row.details.source === 'mcp' && <ToneBadge variant="info">via MCP</ToneBadge>}
                  </span>
                </TableCell>
                <TableCell><DetailChips details={row.details} people={people} /></TableCell>
                {showIp && <TableCell className="font-mono text-xs">{row.ip_address ?? ''}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Surface>
      <Pager page={page} hasMore={log.data?.hasMore ?? false} onPage={onPage} label="Audit log" />
    </>
  );
}

function PortalLog({ filters, page, onPage }: { filters: AuditFilters; page: number; onPage: (p: number) => void }) {
  const log = useQuery({ queryKey: opsKeys.activity(filters, page), queryFn: () => listPortalActivity(filters, page) });
  const rows: ActivityRow[] = log.data?.rows ?? [];
  const people = usePeople(rows);
  const showIp = rows.some((r) => r.ip_address);

  if (log.isError) return <Failed error={log.error} retry={() => void log.refetch()} />;
  if (log.isPending) return <p className="text-sm text-muted-foreground">Loading activity...</p>;
  if (rows.length === 0) {
    return <Surface><EmptyState icon={<ShieldCheck />} title="No portal activity" description="Client sign-ins, uploads, messages and signatures appear here." /></Surface>;
  }
  return (
    <>
      <Surface padding={false}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>What</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Details</TableHead>
              {showIp && <TableHead>Address</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">{formatDateTime(row.created_at)}</TableCell>
                <TableCell><ContactLink id={row.contact_id} people={people} /></TableCell>
                <TableCell>{actionLabel(ACTIVITY_ACTION_LABELS, row.action)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.details.actor_role === 'owner' ? 'You' : row.user_id === null ? 'Automatic' : 'Client'}
                </TableCell>
                <TableCell><DetailChips details={row.details} people={people} /></TableCell>
                {showIp && <TableCell className="font-mono text-xs">{row.ip_address ?? ''}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Surface>
      <Pager page={page} hasMore={log.data?.hasMore ?? false} onPage={onPage} label="Portal activity" />
    </>
  );
}

export function AuditLogPage() {
  const [tab, setTab] = useState<Tab>('owner');
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [page, setPage] = useState(0);

  const change = (next: AuditFilters) => {
    setFilters(next);
    setPage(0);
  };

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who did what, and when" />
      <div className={`${PAGE} flex flex-col gap-3`}>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            change({ ...filters, action: '' });
          }}
        >
          <PageTabsList>
            <PageTabsTrigger value="owner">Owner and system</PageTabsTrigger>
            <PageTabsTrigger value="portal">Portal activity</PageTabsTrigger>
          </PageTabsList>
        </Tabs>
        <Filters filters={filters} onChange={change} labels={tab === 'owner' ? AUDIT_ACTION_LABELS : ACTIVITY_ACTION_LABELS} />
        {tab === 'owner' ? (
          <OwnerLog filters={filters} page={page} onPage={setPage} />
        ) : (
          <PortalLog filters={filters} page={page} onPage={setPage} />
        )}
      </div>
    </>
  );
}
