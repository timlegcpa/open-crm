import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { Contact, ContactService } from '@/api/contacts';
import { Button } from '@/components/ui/button';
import { ClickRegion } from '@/components/ui/click-region';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency, NO_VALUE_TEXT } from '@/lib/format';
import { cn } from '@/lib/utils';
import { computeContactRevenue } from '@/lib/revenue';
import { toAmount, yearlyOfLine } from '../../lib/board';
import { parseCurrencyInput } from '../../lib/quotes';
import type { QuotePatch } from '../../api';
import { useQuoteEditing } from '../../useQuoteEditing';
import {
  CADENCE_OPTIONS,
  entityOptionsOf,
  occupiedByEntity,
  priceLabel,
  QuoteDeleteDialog,
  STATE_OPTIONS,
  useContactOrganizations,
  useServiceCatalog,
  type Cadence,
  type EntityOption,
  type QuoteState,
} from './shared';

const PERSONAL = '__personal';

/**
 * One service as one line that expands in place. The price commits on Enter or when the
 * line closes (its header, another line opening, the bar closing, the card changing),
 * never on blur: a blur commit made Tab-then-Escape a save and raced the cadence switch.
 * An `inflight` ref keeps Enter plus the collapse after it to one write; `sent` adopts a
 * price as the baseline only once its save succeeded, so a failed save can be retried
 * with the same value. While a write or a stage move is in flight the price is held:
 * the input is disabled and a collapse commits nothing. Escape anywhere in the open line
 * cancels, unless a nested menu already handled it. A reopened line starts from the
 * price last saved.
 */
export function CompactQuoteRow({
  row,
  label,
  open,
  onOpenChange,
  moveTargets,
  occupied,
  busy,
  onPatch,
  onDeleteRequest,
}: {
  row: ContactService;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  moveTargets: EntityOption[];
  occupied: Map<string | null, Set<string>>;
  /** A quote write or a stage move is in flight: every control waits, the price included. */
  busy: boolean;
  /** Resolves true when the write landed. */
  onPatch: (row: ContactService, patch: QuotePatch) => Promise<boolean>;
  onDeleteRequest: (row: ContactService) => void;
}) {
  const before = toAmount(row.amount);
  const original = before == null ? '' : String(before);
  const [draft, setDraft] = useState(original);
  const cancelled = useRef(false);
  const sent = useRef<{ amount: number | null } | null>(null);
  const inflight = useRef<{ amount: number | null } | null>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const accepted = row.state === 'accepted';

  useEffect(() => {
    sent.current = null;
  }, [row.amount]);

  function savedText(): string {
    if (!sent.current) return original;
    return sent.current.amount == null ? '' : String(sent.current.amount);
  }

  /** The amount write the draft asks for, or none. A typo or a negative reverts the field. */
  function amountChange(): { amount: number | null } | null {
    if (cancelled.current) return null;
    const next = parseCurrencyInput(draft);
    if (next !== null && (Number.isNaN(next) || next < 0)) {
      setDraft(savedText());
      return null;
    }
    const baseline = inflight.current ?? sent.current;
    return next === (baseline ? baseline.amount : before) ? null : { amount: next };
  }

  /** Sends `patch`, adopting `change` as the saved price only when the write landed. */
  function send(patch: QuotePatch, change: { amount: number | null } | null) {
    inflight.current = change;
    void onPatch(row, patch).then((ok) => {
      if (inflight.current === change) inflight.current = null;
      if (ok && change) sent.current = change;
    });
  }

  function commitAmount() {
    if (busy) return;
    const change = amountChange();
    if (change) send(change, change);
  }
  const commitRef = useRef(commitAmount);
  commitRef.current = commitAmount;
  const openRef = useRef(open);

  useEffect(() => {
    if (openRef.current && !open) commitRef.current();
    if (!openRef.current && open) priceRef.current?.focus();
    openRef.current = open;
  }, [open]);
  // A line still open when the bar closes or the card changes keeps its price.
  useEffect(
    () => () => {
      if (openRef.current) commitRef.current();
    },
    [],
  );
  // A line added from "Add service" mounts open (often while its write is finishing):
  // focus its price as soon as it is editable.
  useEffect(() => {
    if (open && !busy) priceRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  function toggle() {
    if (!open) {
      cancelled.current = false;
      setDraft(savedText());
    }
    onOpenChange(!open);
  }

  const draftAmount = parseCurrencyInput(draft);
  const draftYear = draftAmount !== null && Number.isFinite(draftAmount) ? yearlyOfLine(row.cadence, draftAmount) : null;
  const targets = moveTargets.filter((t) => t.organizationId !== row.organization_id);
  const price = priceLabel(row);

  return (
    <li
      className={cn('rounded-md', open && 'bg-muted/50 ring-1 ring-border')}
      onKeyDown={(e) => {
        if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        cancelled.current = true;
        setDraft(savedText());
        onOpenChange(false);
      }}
    >
      <ClickRegion
        aria-label={`Edit ${label} quote`}
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{label}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', accepted ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
            {accepted ? 'Accepted' : 'Proposed'}
          </span>
        </span>
        <span className={cn('shrink-0 text-[13px] tabular-nums', price === 'Set price' ? 'text-muted-foreground' : 'font-semibold text-foreground')}>
          {price}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </ClickRegion>
      {open && (
        <div className="flex flex-col gap-2.5 px-2 pb-2.5 pt-1">
          <div>
            <label htmlFor={`quote-price-${row.id}`} className="text-[11px] text-muted-foreground">
              Price
            </label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">$</span>
              <Input
                ref={priceRef}
                id={`quote-price-${row.id}`}
                value={draft}
                disabled={busy}
                inputMode="decimal"
                placeholder="Not priced yet"
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitAmount();
                    onOpenChange(false);
                  }
                }}
                className="h-8 bg-background pl-6 pr-12 text-[13px] tabular-nums"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">
                {row.cadence === 'monthly' ? '/mo' : row.cadence === 'annual' ? '/yr' : 'once'}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Segmented<Cadence>
              label="Billing cadence"
              value={row.cadence}
              options={CADENCE_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
              onValueChange={(v) => void onPatch(row, { cadence: v })}
            />
            <div className="min-h-4 text-[11.5px] tabular-nums text-muted-foreground">
              {draftYear != null
                ? `${formatCurrency(draftYear, 0)} a year`
                : row.cadence === 'one_time'
                  ? 'One-time, so it stays out of MRR and ARR'
                  : ''}
            </div>
          </div>
          <Segmented<QuoteState>
            label="Quote state"
            value={row.state}
            options={STATE_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
            onValueChange={(v) => void onPatch(row, { state: v })}
          />
          <div className="flex items-center gap-2 border-t border-border pt-2">
            {targets.length > 0 && (
              <Select
                value=""
                disabled={busy}
                onValueChange={(v) => {
                  // A move remounts the line, so a typed price rides in the SAME write.
                  const change = amountChange();
                  send({ ...change, organization_id: v === PERSONAL ? null : v }, change);
                  onOpenChange(false);
                }}
              >
                <SelectTrigger className="h-7 min-w-0 flex-1 bg-background text-[12px]" aria-label="Move quote">
                  <SelectValue placeholder="Move to" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => {
                    const taken = occupied.get(t.organizationId)?.has(row.service_type) ?? false;
                    return (
                      <SelectItem key={t.organizationId ?? PERSONAL} value={t.organizationId ?? PERSONAL} disabled={taken} className="text-[12px]">
                        {t.label}
                        {taken && ' (already quoted)'}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto text-destructive hover:text-destructive"
              onClick={() => {
                cancelled.current = true;
                onOpenChange(false);
                onDeleteRequest(row);
              }}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** "Add service": every active service not yet quoted, under the person or organization it adds to. */
function CompactAddPanel({
  entities,
  occupied,
  services,
  busy,
  onAdd,
}: {
  entities: EntityOption[];
  occupied: Map<string | null, Set<string>>;
  services: ReadonlyArray<{ key: string; label: string }>;
  busy: boolean;
  onAdd: (organizationId: string | null, serviceType: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = entities
    .map((entity) => ({ entity, services: services.filter((s) => !occupied.get(entity.organizationId)?.has(s.key)) }))
    .filter((g) => g.services.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="mt-1.5">
      <ClickRegion
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add service
      </ClickRegion>
      {open && (
        <div
          className="mt-1 flex flex-col gap-2 rounded-md bg-muted/50 p-2 ring-1 ring-border"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          {groups.map((g) => (
            <div key={g.entity.organizationId ?? PERSONAL} role="group" aria-label={`Add a service for ${g.entity.label}`}>
              {entities.length > 1 && <div className="pb-1 text-[11px] font-medium text-muted-foreground">{g.entity.label}</div>}
              <div className="flex flex-wrap gap-1">
                {g.services.map((s) => (
                  <ClickRegion
                    key={s.key}
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      onAdd(g.entity.organizationId, s.key);
                    }}
                    className="rounded-sm border border-border bg-background px-2 py-1 text-[12px] text-foreground hover:bg-muted"
                  >
                    {s.label}
                  </ClickRegion>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The board card bar's services editor: MRR and ARR on top, one line per quote, and
 * "Add service". It drives the same quote write path as the Billing tab.
 */
export function CompactQuoteEditor({
  contact,
  disabled = false,
  onBusyChange,
}: {
  contact: Contact;
  /** A stage move for this contact is running: hold every quote control. */
  disabled?: boolean;
  /** Tells the card bar whether a quote write is in flight, to hold its stage picker. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const organizations = useContactOrganizations(contact.id);
  const catalog = useServiceCatalog();
  const editing = useQuoteEditing(contact);
  const rows = contact.contact_services;
  const entities = useMemo(() => entityOptionsOf(organizations.data ?? []), [organizations.data]);
  const occupied = useMemo(() => occupiedByEntity(rows), [rows]);
  const busy = editing.busy || disabled;
  const [deleteTarget, setDeleteTarget] = useState<ContactService | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<{ organizationId: string | null; serviceType: string } | null>(null);

  useEffect(() => {
    onBusyChange?.(editing.busy);
  }, [editing.busy, onBusyChange]);

  // A service just added opens as soon as its row arrives.
  useEffect(() => {
    if (!justAdded) return;
    const hit = rows.find((r) => r.service_type === justAdded.serviceType && r.organization_id === justAdded.organizationId);
    if (hit) {
      setOpenId(hit.id);
      setJustAdded(null);
    }
  }, [rows, justAdded]);

  // Earned figures from accepted quotes only (the shared revenue rules); proposed apart.
  const revenue = useMemo(() => computeContactRevenue(contact), [contact]);
  const labelOf = (key: string) => catalog.labels.get(key) ?? key;
  const patch = (row: ContactService, p: QuotePatch) => editing.patchQuote(row, p);

  return (
    <div className="text-[13px]">
      {rows.length > 0 ? (
        <>
          <div className="grid grid-cols-2 divide-x divide-border rounded-sm bg-muted/60">
            <div className="px-2 py-1.5">
              <div className="text-[11px] text-muted-foreground">MRR</div>
              <div className="text-[14px] font-semibold tabular-nums">{revenue.mrr > 0 ? formatCurrency(revenue.mrr, 0) : NO_VALUE_TEXT}</div>
            </div>
            <div className="px-2 py-1.5">
              <div className="text-[11px] text-muted-foreground">ARR</div>
              <div className="text-[14px] font-semibold tabular-nums">{revenue.arr > 0 ? formatCurrency(revenue.arr, 0) : NO_VALUE_TEXT}</div>
            </div>
          </div>
          {(revenue.oneTimeTotal > 0 || revenue.proposedAnnualized > 0) && (
            <div className="mt-1 flex flex-wrap justify-end gap-x-2 text-[11.5px] tabular-nums text-muted-foreground">
              {revenue.oneTimeTotal > 0 && <span>+ {formatCurrency(revenue.oneTimeTotal, 0)} one-time</span>}
              {revenue.proposedAnnualized > 0 && <span>{formatCurrency(revenue.proposedAnnualized, 0)} a year proposed</span>}
            </div>
          )}
        </>
      ) : (
        <div className="text-muted-foreground">No services quoted</div>
      )}
      {entities.map((entity) => {
        const entityRows = rows.filter((r) => r.organization_id === entity.organizationId);
        if (entityRows.length === 0) return null;
        return (
          <div key={entity.organizationId ?? PERSONAL} className="mt-1.5">
            {entities.length > 1 && <div className="px-2 pb-0.5 text-[11px] font-medium text-muted-foreground">{entity.label}</div>}
            <ul className="flex flex-col gap-0.5">
              {entityRows.map((row) => (
                <CompactQuoteRow
                  key={row.id}
                  row={row}
                  label={labelOf(row.service_type)}
                  open={openId === row.id}
                  onOpenChange={(next) => setOpenId(next ? row.id : null)}
                  moveTargets={entities}
                  occupied={occupied}
                  busy={busy}
                  onPatch={patch}
                  onDeleteRequest={setDeleteTarget}
                />
              ))}
            </ul>
          </div>
        );
      })}
      <CompactAddPanel
        entities={entities}
        occupied={occupied}
        services={catalog.active}
        busy={busy}
        onAdd={(organizationId, serviceType) => {
          setOpenId(null);
          setJustAdded({ organizationId, serviceType });
          void editing.addQuote({
            organization_id: organizationId,
            service_type: serviceType,
            state: 'proposed',
            cadence: catalog.byKey.get(serviceType)?.default_cadence ?? 'monthly',
            amount: null,
          });
        }}
      />
      <QuoteDeleteDialog
        target={deleteTarget}
        label={deleteTarget ? labelOf(deleteTarget.service_type) : ''}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const row = deleteTarget;
          setDeleteTarget(null);
          if (row) void editing.removeQuote(row);
        }}
      />
    </div>
  );
}
