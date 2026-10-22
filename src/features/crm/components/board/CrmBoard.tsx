import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Archive, ChevronRight, Filter, Plus, Search, StickyNote, X } from 'lucide-react';
import { listNotesForStatuses } from '@/api/contactNotes';
import type { Contact } from '@/api/contacts';
import type { ContactStatus } from '@/api/pickLists';
import { queryKeys } from '@/api/queryKeys';
import { ContactEmailsManager } from '@/components/contacts/ContactEmailsManager';
import { StatusMonogram, statusDotStyle } from '@/components/contacts/StatusBadge';
import { Button } from '@/components/ui/button';
import { ClickRegion } from '@/components/ui/click-region';
import { CopyValue } from '@/components/ui/copy-value';
import { Input } from '@/components/ui/input';
import { initialsOf } from '@/components/ui/monogram';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusPill } from '@/components/ui/status-pill';
import { useLeadSources } from '@/hooks/usePickLists';
import { links } from '@/features/links';
import { isSystemStatus, PIPELINE_STATUSES } from '@/lib/contactStatus';
import { formatCurrencyShort } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactFieldSave } from '../../hooks';
import {
  cadenceText,
  latestNotes,
  leadPipeline,
  matchesServiceFilter,
  mrrArrText,
  quotedServiceTypes,
  viewLabel,
  type BoardOrganization,
  type LeadGroup,
  type LeadRow,
  type ServiceFilter,
} from '../../lib/board';
import { isTypingContext, moveForDrop } from '../../lib/interaction';
import { quoteOpMutationKey } from '../../lib/quotes';
import { EditableField } from '../EditableField';
import { quickCopyItems } from '../RecordRightBar';
import { NewLeadDialog } from './NewLeadDialog';

// Loaded only when a card opens, so the board never carries the editor until it is used.
const CompactQuoteEditor = lazy(() => import('../quotes/CompactQuoteEditor').then((m) => ({ default: m.CompactQuoteEditor })));

const SECTION_HEAD = 'text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground';
const FIELD_LABEL = 'text-[11px] text-muted-foreground';
// No shadow: surfaces separate by border, and the card's border is the full token so it
// reads on the lane in both themes. The left edge carries the stage's colour.
const CARD_CLASS = 'rounded-lg border border-l-[3px] border-border bg-card p-2.5';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * A stage's colour on the board: a faint wash and a border for its lane, a stronger wash
 * for the lane's heading, the card's left edge. From `contact_statuses.colour` (the
 * owner's), drawn only as tints and edges, never as text; no colour draws the plain lane.
 */
function stageTone(status: ContactStatus | undefined): { lane?: CSSProperties; head?: CSSProperties; card?: CSSProperties } {
  const c = status?.colour;
  if (!c || !HEX.test(c)) return {};
  return {
    lane: { borderColor: `${c}40`, backgroundColor: `${c}0a` },
    head: { backgroundColor: `${c}1f`, borderColor: `${c}40` },
    card: { borderLeftColor: c },
  };
}

/** Drop where the pointer is; fall back to overlap between lanes. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/** Who the lead is, then what was quoted. "No quote yet" is a first-class answer. */
function rowSummary(row: LeadRow): string {
  const services = [...new Set(row.lines.map((l) => l.serviceLabel))];
  const orgs = [...new Set(row.lines.map((l) => l.organizationName).filter(Boolean))];
  return [row.businessName, services.length > 0 ? services.join(', ') : 'No quote yet', ...orgs.filter((o) => o !== row.businessName)]
    .filter(Boolean)
    .join(' · ');
}

function CardBody({ row, compact, status }: { row: LeadRow; compact: boolean; status: ContactStatus | undefined }) {
  const yearly = mrrArrText(row);
  const once = row.oneTime > 0 ? `${formatCurrencyShort(row.oneTime)} once` : '';
  const quoted = cadenceText(row);
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {!compact && <StatusMonogram initials={initialsOf(row.name)} status={status} />}
        <span className={cn('min-w-0 text-[13px] font-semibold', compact ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'truncate')}>{row.name}</span>
      </span>
      <span className={cn('mt-1.5 text-[12px] text-muted-foreground', compact ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'block truncate')}>
        {rowSummary(row)}
      </span>
      {(row.lines.length > 0 || row.note || !row.reachable) && (
        <span className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
          {row.lines.length > 0 && (
            <span
              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12.5px] font-semibold tabular-nums"
              title={quoted ? `Quoted: ${quoted}` : 'Quoted, no price yet'}
            >
              {yearly || once ? (
                <>
                  {/* Each figure stays whole, so a narrow card breaks after the dot, never
                      between "$6,000" and "ARR". */}
                  {(yearly || once).split(' · ').map((part, i, parts) => (
                    <span key={part} className="whitespace-nowrap">
                      {part}
                      {i < parts.length - 1 && ' · '}
                    </span>
                  ))}
                  {yearly && once && <span className="text-[11.5px] font-normal text-muted-foreground">+ {once}</span>}
                </>
              ) : (
                'Quoted, no price yet'
              )}
            </span>
          )}
          {/* The newest note, text only: its age is not shown. The full log is on the record. */}
          {row.note && (
            <span className="flex min-w-0 items-start gap-1 text-[11.5px] leading-4 text-muted-foreground" title={row.note}>
              <StickyNote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-3 min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{row.note}</span>
            </span>
          )}
          {/* The one flag on the board: a lead nobody can contact. */}
          {!row.reachable && (
            <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-warning">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0">No email or phone</span>
            </span>
          )}
        </span>
      )}
    </>
  );
}

function BoardCard(props: {
  row: LeadRow;
  selected: boolean;
  onSelect: (id: string) => void;
  compact: boolean;
  status: ContactStatus | undefined;
  /** Archive this person; absent hides the action. */
  onArchive?: (id: string) => void;
  /** A move or an archive for this person is saving: the card holds still. */
  busy: boolean;
}) {
  const { row, selected, onSelect, onArchive, busy } = props;
  // The card never moves itself: the drag overlay carries a copy above every lane.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.contactId, disabled: busy });
  return (
    <li className="group/card relative">
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`Show ${row.name}`}
        onClick={() => onSelect(row.contactId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect(row.contactId);
          else listeners?.onKeyDown?.(e);
        }}
        style={stageTone(props.status).card}
        className={cn(
          CARD_CLASS,
          'block cursor-grab touch-none select-none outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring',
          onArchive && 'pr-8',
          selected && 'ring-2 ring-ring',
          (isDragging || busy) && 'opacity-40',
        )}
      >
        <CardBody {...props} />
      </div>
      {onArchive && (
        <ClickRegion
          aria-label={`Archive ${row.name}`}
          title="Archive: off the pipeline, record kept"
          disabled={busy}
          onClick={() => onArchive(row.contactId)}
          className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-focus-within/card:opacity-100 md:group-hover/card:opacity-100"
        >
          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
        </ClickRegion>
      )}
    </li>
  );
}

function BoardColumn({
  group,
  label,
  status,
  active,
  onToggle,
  selectedId,
  onSelect,
  compact,
  onArchive,
  busyIds,
}: {
  group: LeadGroup;
  label: string;
  status: ContactStatus | undefined;
  active: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact: boolean;
  onArchive?: (id: string) => void;
  busyIds: ReadonlySet<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: group.status });
  const people = group.rows.length;
  const money = cadenceText(group);
  const tone = stageTone(status);
  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} column`}
      style={tone.lane}
      // A bordered, lightly tinted lane in the stage's colour; the cards carry their own border.
      className="relative flex min-h-0 min-w-[150px] flex-1 basis-0 flex-col rounded-lg border border-border bg-muted/40"
    >
      {/* The drop outline is an overlay inside the lane: a ring offset outside it was clipped
          by the board's scroller on three sides. Above the heading too, so nothing covers it. */}
      {isOver && <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-lg ring-2 ring-inset ring-ring" />}
      {/* The heading is the filter: it writes ?view=, so the index narrows to this column. */}
      <ClickRegion
        onClick={onToggle}
        aria-pressed={active}
        disabled={people === 0}
        style={tone.head}
        className={cn('flex w-full flex-col items-start gap-1 rounded-t-lg border-b border-border px-2.5 py-2', people > 0 && 'hover:bg-background/70', active && 'ring-1 ring-inset ring-ring')}
      >
        <span className="flex w-full items-center gap-1.5">
          <StatusPill dotClassName="bg-muted-foreground" dotStyle={statusDotStyle(status)}>
            {label}
          </StatusPill>
          {active && <Filter className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </span>
        <span className="px-0.5 text-[11.5px] tabular-nums text-muted-foreground">
          {people} {people === 1 ? 'person' : 'people'}
        </span>
        {money && <span className="px-0.5 text-[12px] font-semibold tabular-nums">{money}</span>}
      </ClickRegion>
      {people === 0 ? (
        <p className="m-1.5 rounded-lg border border-dashed border-border px-2 py-4 text-center text-[12px] text-muted-foreground">Nobody here right now.</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1" fitWidth>
          <ul className="flex flex-col gap-2 p-1.5" aria-label={label}>
            {group.rows.map((row) => (
              <BoardCard
                key={row.contactId}
                row={row}
                selected={row.contactId === selectedId}
                onSelect={onSelect}
                compact={compact}
                status={status}
                onArchive={onArchive}
                busy={busyIds.has(row.contactId)}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}

/**
 * The card's bar: the stage, quick edit, the values to copy, the services and the door
 * to the full record. A quote edit and a stage move for one contact wait for each other:
 * the stage picker is off while a quote saves, the quotes while a move does.
 */
function CardBar({
  contact,
  row,
  view,
  stageOptions,
  sourceOptions,
  onClose,
  onMoveStage,
  moving,
  onArchive,
}: {
  contact: Contact;
  row: LeadRow;
  view: string | null;
  stageOptions: Array<{ value: string; label: string }>;
  sourceOptions: Array<{ value: string; label: string }>;
  onClose: () => void;
  onMoveStage: (contactId: string, status: string) => void;
  moving: boolean;
  onArchive?: () => void;
}) {
  const save = useContactFieldSave(contact);
  const quoteSaving = useIsMutating({ mutationKey: quoteOpMutationKey(contact.id) }) > 0;
  // Email and phone are edited above; the copy list keeps the rest.
  const items = quickCopyItems(contact).filter((i) => i.key !== 'email' && i.key !== 'phone');
  return (
    <aside aria-label={`${row.name} details`} className={cn('flex min-h-0 shrink-0 flex-col border border-border bg-card max-md:max-h-[70vh] max-md:w-full md:w-[300px]')}>
      <ScrollArea className="h-full min-h-0" fitWidth>
        <div className="flex items-start gap-2 border-b border-border px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{row.name}</div>
            {row.businessName && <div className="truncate text-[12px] text-muted-foreground">{row.businessName}</div>}
          </div>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-col gap-1.5 border-b border-border px-3.5 py-2.5">
          <div className={SECTION_HEAD}>Stage</div>
          <Select value={contact.status} onValueChange={(v) => onMoveStage(contact.id, v)} disabled={quoteSaving || moving}>
            <SelectTrigger className="h-8 text-[13px]" aria-label="Stage"><SelectValue /></SelectTrigger>
            <SelectContent>
              {stageOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {onArchive && (
            <Button type="button" variant="ghost" size="sm" className="justify-start text-muted-foreground" disabled={moving} onClick={onArchive}>
              <Archive aria-hidden="true" />
              Archive person
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 border-b border-border px-3.5 py-2.5">
          <div>
            <div className={FIELD_LABEL}>Email</div>
            <ContactEmailsManager contactId={contact.id} kind="primary" />
          </div>
          <div>
            <div className={FIELD_LABEL}>Phone</div>
            <EditableField type="phone" label="Phone" value={contact.phone} placeholder="Add phone" onSave={save('phone')} />
          </div>
          <div>
            <div className={FIELD_LABEL}>Source</div>
            <EditableField type="select" label="Source" value={contact.source} options={sourceOptions} onSave={save('source')} />
          </div>
        </div>
        {items.length > 0 && (
          <dl className="flex flex-col border-b border-border py-1 text-[13px]">
            {items.map((item) => (
              <div key={item.key} className="px-3.5 py-1">
                <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
                <dd><CopyValue value={item.value} label={item.label.toLowerCase()} className="[overflow-wrap:anywhere]" /></dd>
              </div>
            ))}
          </dl>
        )}
        <div className="border-b border-border px-3.5 py-2.5 text-[12.5px]">
          <div className={cn(SECTION_HEAD, 'mb-1.5')}>Services</div>
          <Suspense fallback={<p className="text-muted-foreground">Loading services...</p>}>
            <CompactQuoteEditor contact={contact} disabled={moving} />
          </Suspense>
        </div>
        <div className="px-3.5 py-2.5">
          <Link
            to={`${links.contact(contact.id)}${view ? `?view=${encodeURIComponent(view)}` : ''}`}
            className="inline-flex items-center gap-1 text-[13px] font-medium underline-offset-2 hover:underline"
          >
            Open record <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </ScrollArea>
    </aside>
  );
}

export interface CrmBoardProps {
  /** Every contact; the board filters to pipeline stages and the search itself. */
  contacts: readonly Contact[];
  organizations: readonly BoardOrganization[];
  serviceLabels: ReadonlyMap<string, string>;
  statusByKey: ReadonlyMap<string, ContactStatus>;
  search: string;
  onSearch: (value: string) => void;
  /** THE search matcher, shared with the index beside the board. */
  matches: (c: Contact) => boolean;
  view: string | null;
  onView: (view: string | null) => void;
  loading: boolean;
  /** Resolves when the move has settled (saved or failed). */
  onMoveStage: (contactId: string, status: string) => Promise<void>;
  /** Archive a person from their card or its bar; resolves when it has settled. Absent hides the action. */
  onArchive?: (contact: Contact) => Promise<void>;
  /** People whose archive is saving: their cards hold still. */
  archivingIds?: ReadonlySet<string>;
}

/**
 * The pipeline board: one column per open stage, newest first, never by money, each lane in
 * its stage's colour. Cards drag between columns; a click opens the card's bar; a card's
 * archive takes the person off the pipeline and keeps their record. `/` focuses the search
 * (capture phase, so it wins over any shell listener) and yields while typing.
 */
export function CrmBoard({
  contacts,
  organizations,
  serviceLabels,
  statusByKey,
  search,
  onSearch,
  matches,
  view,
  onView,
  loading,
  onMoveStage,
  onArchive,
  archivingIds,
}: CrmBoardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(new Set());
  const [service, setService] = useState<ServiceFilter>('all');
  const [newOpen, setNewOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sources = useLeadSources();
  // Each card's note line. staleTime 0 overrides the app's default on purpose: the AI
  // connector writes notes too, and nothing here would invalidate this key for those, so
  // coming back to the board refetches.
  const noteRows = useQuery({
    queryKey: queryKeys.contacts.leadNotes(),
    queryFn: () => listNotesForStatuses(PIPELINE_STATUSES),
    staleTime: 0,
  });
  const notes = useMemo(() => latestNotes(noteRows.data ?? []), [noteRows.data]);
  // A drag needs 6px of travel, so a click on a card stays a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  // One pill per service quoted to someone on the board, so a pill never shows an empty board.
  const serviceOptions = useMemo(() => {
    const quoted = quotedServiceTypes(contacts.filter((c) => (PIPELINE_STATUSES as readonly string[]).includes(c.status)));
    const keys = [...quoted].sort((a, b) => (serviceLabels.get(a) ?? a).localeCompare(serviceLabels.get(b) ?? b));
    return [{ value: 'all', label: 'All' }, ...keys.map((k) => ({ value: k, label: serviceLabels.get(k) ?? k }))];
  }, [contacts, serviceLabels]);
  // A chosen service nobody is quoted for any more falls back to All.
  const activeService: ServiceFilter = serviceOptions.some((o) => o.value === service) ? service : 'all';
  const groups = useMemo(
    () =>
      leadPipeline(
        contacts.filter((c) => matches(c) && matchesServiceFilter(c, activeService)),
        { serviceLabels, organizations, statusOrder: statusByKey },
        notes,
      ),
    [contacts, matches, activeService, serviceLabels, organizations, statusByKey, notes],
  );
  const totalPeople = groups.reduce((n, g) => n + g.rows.length, 0);
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const findRow = (id: string | null) => {
    for (const g of groups) {
      const r = g.rows.find((x) => x.contactId === id);
      if (r) return r;
    }
    return null;
  };
  const selectedRow = findRow(selectedId);
  const selectedContact = selectedRow ? (contactById.get(selectedRow.contactId) ?? null) : null;
  const draggingRow = findRow(draggingId);
  const statusLabel = (key: string) => statusByKey.get(key)?.label ?? key;
  const activeLabel = viewLabel(view, statusLabel);

  const stageOptions = [...statusByKey.values()]
    .filter((s) => !isSystemStatus(s.key) || s.key === selectedContact?.status)
    .map((s) => ({ value: s.key, label: s.label }));
  const sourceOptions = (sources.data ?? [])
    .filter((s) => s.is_active || s.key === selectedContact?.source)
    .map((s) => ({ value: s.key, label: s.label }));

  const move = async (id: string, status: string) => {
    setMovingIds((prev) => new Set(prev).add(id));
    try {
      await onMoveStage(id, status);
    } finally {
      setMovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const busyIds = useMemo(() => new Set([...movingIds, ...(archivingIds ?? [])]), [movingIds, archivingIds]);
  const archive = onArchive
    ? (id: string) => {
        const c = contactById.get(id);
        if (c) void onArchive(c);
      }
    : undefined;

  const onDragEnd = (e: DragEndEvent) => {
    setDraggingId(null);
    const drop = moveForDrop(String(e.active.id), e.over ? String(e.over.id) : null, (id) => contactById.get(id)?.status, groups.map((g) => g.status));
    if (drop) void move(drop.contactId, drop.status);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingContext(e.target as HTMLElement | null, false)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pb-4 pt-4 md:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full md:w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            aria-label="Search the pipeline"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search leads"
            className="h-8 pl-8 pr-8 text-[12.5px]"
          />
          {search && (
            <ClickRegion onClick={() => onSearch('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:bg-muted">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </ClickRegion>
          )}
        </div>
        {/* Narrows the board to the leads quoted for one service. */}
        {serviceOptions.length > 1 && (
          <Segmented label="Service" value={activeService} onValueChange={setService} options={serviceOptions} />
        )}
        {activeLabel && (
          <StatusPill>
            {activeLabel}
            <ClickRegion onClick={() => onView(null)} aria-label="Clear list filter" className="inline-flex">
              <X className="h-3 w-3" aria-hidden="true" />
            </ClickRegion>
          </StatusPill>
        )}
        <Button type="button" size="sm" className="md:ml-auto" onClick={() => setNewOpen(true)}>
          <Plus aria-hidden="true" />
          New
        </Button>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {loading ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">Loading...</p>
        ) : totalPeople === 0 ? (
          <p className="rounded-lg border border-border py-6 text-center text-[12px] text-muted-foreground">
            {search ? (
              `No lead matches "${search}".`
            ) : activeService !== 'all' ? (
              <>
                No lead has {serviceLabels.get(activeService) ?? activeService} quoted.{' '}
                <ClickRegion onClick={() => setService('all')} aria-label="Clear the service filter" className="underline">
                  Show all
                </ClickRegion>
              </>
            ) : (
              'No leads. Add one with New.'
            )}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 max-md:flex-col">
            <DndContext
              sensors={sensors}
              collisionDetection={collision}
              onDragStart={(e) => setDraggingId(String(e.active.id))}
              onDragCancel={() => setDraggingId(null)}
              onDragEnd={onDragEnd}
            >
              <ScrollArea className="min-h-0 min-w-0 flex-1" horizontal>
                <div className="flex h-full min-h-[320px] gap-2 pb-2">
                  {groups.map((group) => (
                    <BoardColumn
                      key={group.key}
                      group={group}
                      label={statusLabel(group.status)}
                      status={statusByKey.get(group.status)}
                      active={view === group.key}
                      onToggle={() => onView(view === group.key ? null : group.key)}
                      selectedId={selectedId}
                      onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
                      compact={selectedRow !== null}
                      onArchive={archive}
                      busyIds={busyIds}
                    />
                  ))}
                </div>
              </ScrollArea>
              <DragOverlay dropAnimation={null}>
                {draggingRow && (
                  <div data-drag-overlay style={stageTone(statusByKey.get(draggingRow.status)).card} className={cn(CARD_CLASS, 'cursor-grabbing ring-2 ring-ring/50')}>
                    <CardBody row={draggingRow} compact={selectedRow !== null} status={statusByKey.get(draggingRow.status)} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            {selectedRow && selectedContact && (
              // Keyed by contact: a half-typed draft never carries to the next card.
              <CardBar
                key={selectedContact.id}
                contact={selectedContact}
                row={selectedRow}
                view={view}
                stageOptions={stageOptions}
                sourceOptions={sourceOptions}
                onClose={() => setSelectedId(null)}
                onMoveStage={(id, status) => void move(id, status)}
                moving={busyIds.has(selectedContact.id)}
                onArchive={archive ? () => archive(selectedContact.id) : undefined}
              />
            )}
          </div>
        )}
      </div>
      <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} stageLabel={statusLabel} />
    </div>
  );
}
