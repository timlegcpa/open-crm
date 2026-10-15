import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { CountBadge } from '@/components/ui/count-badge';
import { StatusPill } from '@/components/ui/status-pill';
import { Monogram, initialsOf } from '@/components/ui/monogram';
import { ClickRegion } from '@/components/ui/click-region';
import { contactDisplayName } from '@/api/contacts';
import { matchesContactSearch } from '@/lib/contactSearch';
import { isClientLike, isLeadLike } from '@/lib/contactStatus';
import { safeStorage, storageKey } from '@/lib/storage';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { cn } from '@/lib/utils';
import { documentKeys, getUnreviewedDetailed } from '../api';
import type { ExplorerContact } from './types';

/**
 * The documents index: the explorer's left pane, one row per contact.
 *
 * It lists contacts, not a folder tree. Selecting a contact draws
 * `ClientOverviewPane`, which lists the root folders AND files of both sections
 * and navigates into a folder on click; from there the breadcrumb and `FileGrid`
 * own the drilling. A tree here would be a second, smaller copy of that list.
 *
 * Three groups, each A-Z: clients, leads, and everyone else the roster holds (a
 * former client whose files are still kept, say). A group renders only when it
 * holds someone, and its collapsed state is remembered per browser. The row's
 * right edge is the contact's unreviewed count: the fact this screen is about.
 */

interface FolderTreeProps {
  clients: ExplorerContact[];
  selectedClientId: string | null;
  onSelectClient: (clientId: string, clientName: string) => void;
}

type GroupKey = 'clients' | 'leads' | 'others';

const GROUPS: ReadonlyArray<{ key: GroupKey; title: string; test: (status: string) => boolean }> = [
  { key: 'clients', title: 'Clients', test: isClientLike },
  { key: 'leads', title: 'Leads', test: isLeadLike },
  { key: 'others', title: 'Others', test: () => true },
];

const COLLAPSED_KEY = storageKey('documents', 'index-collapsed');

function isCollapsedMap(value: unknown): value is Record<string, boolean> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((v) => typeof v === 'boolean');
}

export default function FolderTree({ clients, selectedClientId, onSelectClient }: FolderTreeProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    () => safeStorage.getJson(COLLAPSED_KEY, isCollapsedMap) ?? {},
  );
  const toggleCollapsed = (key: GroupKey) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      safeStorage.setJson(COLLAPSED_KEY, next);
      return next;
    });
  };

  const { data: unreviewedDetailed = {} } = useQuery({
    queryKey: documentKeys.unreviewedDetailed(),
    queryFn: getUnreviewedDetailed,
    refetchInterval: 30000,
  });
  const { data: statuses } = useContactStatuses();
  const statusByKey = useByKey(statuses);

  /** Per-contact totals: unreviewed documents plus unreviewed folders. */
  const unreviewedByClient = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [cid, det] of Object.entries(unreviewedDetailed)) counts[cid] = det.docs.length + det.folders.length;
    return counts;
  }, [unreviewedDetailed]);

  const groups = useMemo(() => {
    const matched = clients.filter((c) => matchesContactSearch(c, search));
    const byName = [...matched].sort((a, b) =>
      contactDisplayName(a).localeCompare(contactDisplayName(b), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    const placed = new Set<string>();
    return GROUPS.map((g) => {
      const rows = byName.filter((c) => !placed.has(c.id) && g.test(c.status));
      for (const r of rows) placed.add(r.id);
      return { ...g, rows };
    });
  }, [clients, search]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-background">
      <div className="shrink-0 px-2.5 pb-1.5 pt-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search contacts"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" fitWidth>
        <div className="px-1.5 pb-2">
          {total === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">
              {search ? 'No contacts match your search.' : 'No contacts yet.'}
            </p>
          ) : (
            groups.map((group) => {
              if (group.rows.length === 0) return null;
              const isCollapsed = !!collapsed[group.key];
              const Chevron = isCollapsed ? ChevronRight : ChevronDown;
              return (
                <div key={group.key} className="mb-2">
                  <ClickRegion
                    onClick={() => toggleCollapsed(group.key)}
                    aria-expanded={!isCollapsed}
                    className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5"
                  >
                    <Chevron className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{group.rows.length}</span>
                  </ClickRegion>
                  {!isCollapsed && (
                    <ul>
                      {group.rows.map((client) => (
                        <ContactRow
                          key={client.id}
                          contact={client}
                          selected={client.id === selectedClientId}
                          unreviewed={unreviewedByClient[client.id] || 0}
                          // A status label only where the group does not already say it.
                          statusLabel={group.key === 'others' ? statusByKey.get(client.status)?.label ?? client.status : null}
                          onOpen={onSelectClient}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ContactRow({
  contact,
  selected,
  unreviewed,
  statusLabel,
  onOpen,
}: {
  contact: ExplorerContact;
  selected: boolean;
  unreviewed: number;
  statusLabel: string | null;
  onOpen: (clientId: string, clientName: string) => void;
}) {
  const name = contactDisplayName(contact);
  // The subtitle tells two people with the same name apart.
  const subtitle = contact.full_name ? contact.business_name || contact.email : contact.email;
  return (
    <li>
      <ClickRegion
        onClick={() => onOpen(contact.id, name)}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
          selected ? 'bg-secondary' : 'hover:bg-muted',
        )}
      >
        <Monogram initials={initialsOf(name)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{name}</span>
          {subtitle && <span className="block truncate text-[11.5px] text-muted-foreground">{subtitle}</span>}
        </span>
        {statusLabel && <StatusPill muted>{statusLabel}</StatusPill>}
        <CountBadge
          value={unreviewed}
          className="shrink-0"
          title={`${unreviewed} unreviewed item${unreviewed === 1 ? '' : 's'}`}
        />
      </ClickRegion>
    </li>
  );
}
