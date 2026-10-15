import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import type { Contact, ContactService } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { Panel } from '@/components/layout/page';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import type { ContactTabProps } from '@/features/types';
import { getErrorMessage } from '@/lib/errors';
import { formatCurrency } from '@/lib/format';
import { computeContactRevenue, contactProposedTotals, num, upsellProposedTotals } from '@/lib/revenue';
import { cn } from '@/lib/utils';
import {
  createUpsell,
  deleteUpsell,
  listUpsells,
  updateUpsell,
  UPSELL_STATUSES,
  type ContactUpsell,
  type QuotePatch,
  type UpsellStatus,
} from '../api';
import { useContact } from '../hooks';
import { crmKeys } from '../keys';
import { parseCurrencyInput } from '../lib/quotes';
import { useQuoteEditing, type QuoteEditing } from '../useQuoteEditing';
import { EditableField } from './EditableField';
import { AddOrganizationPopover, EditOrganizationPopover, useOrganizationMutations } from './OrganizationEditing';
import { ORGANIZATION_STATUS_LABELS } from '../lib/organizations';
import {
  CADENCE_OPTIONS,
  entityOptionsOf,
  occupiedByEntity,
  QuoteDeleteDialog,
  STATE_OPTIONS,
  useContactOrganizations,
  useServiceCatalog,
  type Cadence,
  type EntityOption,
  type QuoteState,
} from './quotes/shared';

const UPSELL_LABEL: Record<UpsellStatus, string> = { open: 'Open', pitched: 'Pitched', won: 'Won', passed: 'Passed' };
const CADENCE_SUFFIX: Record<string, string> = { monthly: '/mo', annual: '/yr', one_time: ' once' };
const PERSONAL = '__personal';

/** Billing: quotes per person and organization, and upsell ideas. Money lives here, not on Overview. */
export function BillingTab({ contactId }: ContactTabProps) {
  const { contacts, contact } = useContact(contactId);
  if (contacts.isPending) return <p className="text-[13px] text-muted-foreground">Loading billing...</p>;
  if (contacts.isError) return <p role="alert" className="text-[13px] text-destructive">{getErrorMessage(contacts.error)}</p>;
  if (!contact) return null;
  return <BillingBody contact={contact} />;
}

function BillingBody({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const editing = useQuoteEditing(contact);
  const organizations = useContactOrganizations(contact.id);
  const orgs = useMemo(() => organizations.data ?? [], [organizations.data]);
  const entities = useMemo(() => entityOptionsOf(orgs), [orgs]);
  const catalog = useServiceCatalog();
  const orgMutations = useOrganizationMutations(contact.id);
  const upsells = useQuery({ queryKey: crmKeys.upsells(contact.id), queryFn: () => listUpsells(contact.id) });
  const upsellRows = useMemo(() => upsells.data ?? [], [upsells.data]);

  const revenue = computeContactRevenue(contact);
  const proposed = contactProposedTotals(revenue, upsellRows);
  const open = upsellProposedTotals(upsellRows);

  // Upsell writes refresh the whole contacts prefix: the marketing rollups nest under it.
  const refreshUpsells = () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
  const addUpsell = useMutation({ mutationFn: createUpsell, onError: (e) => toast.error(getErrorMessage(e, 'The upsell was not added.')), onSettled: refreshUpsells });
  const setUpsellStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: UpsellStatus }) => updateUpsell(id, { status }),
    onError: (e) => toast.error(getErrorMessage(e, 'The upsell was not saved.')),
    onSettled: refreshUpsells,
  });
  const removeUpsell = useMutation({ mutationFn: deleteUpsell, onError: (e) => toast.error(getErrorMessage(e, 'The upsell was not deleted.')), onSettled: refreshUpsells });

  const [pricingTarget, setPricingTarget] = useState<ContactUpsell | null>(null);

  const figure = (label: string, value: number, tone: string) => (
    <span className="text-muted-foreground">
      {label} <span className={cn('font-semibold tabular-nums', tone)}>{formatCurrency(value, 0)}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Pricing"
        action={
          <div className="flex flex-wrap items-center justify-end gap-x-3 text-[12px] normal-case tracking-normal">
            {figure('MRR', revenue.mrr, 'text-foreground')}
            {figure('ARR', revenue.arr, 'text-foreground')}
            {revenue.oneTimeTotal > 0 && figure('One-time', revenue.oneTimeTotal, 'text-foreground')}
            {proposed.proposedMRR > 0 && figure('Proposed MRR', proposed.proposedMRR, 'text-muted-foreground')}
            {proposed.proposedARR > 0 && figure('Proposed ARR', proposed.proposedARR, 'text-muted-foreground')}
          </div>
        }
      >
        {organizations.isError && <p role="alert" className="px-4 py-2 text-[13px] text-destructive">{getErrorMessage(organizations.error)}</p>}
        {entities.map((entity) => {
          const organization = entity.organizationId ? orgs.find((o) => o.id === entity.organizationId) : undefined;
          return (
            <EntityQuotes
              key={entity.organizationId ?? PERSONAL}
              entity={entity}
              entities={entities}
              rows={contact.contact_services}
              editing={editing}
              catalog={catalog}
              header={
                organization && (
                  <>
                    <EditOrganizationPopover
                      organization={organization}
                      saving={orgMutations.isSaving(organization.id)}
                      onSave={(draft, opened) => orgMutations.update(organization, draft, opened)}
                    />
                    {organization.status !== 'active' && (
                      <span className="rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">
                        {ORGANIZATION_STATUS_LABELS[organization.status] ?? organization.status}
                      </span>
                    )}
                  </>
                )
              }
            />
          );
        })}
        <div className="px-4 py-2">
          <AddOrganizationPopover onCreate={orgMutations.create} creating={orgMutations.creating} />
        </div>
      </Panel>

      <Panel
        title="Upsells"
        action={
          open.proposedMRR + open.proposedAnnual + open.proposedOneTime > 0 ? (
            <span className="text-[12px] normal-case tracking-normal text-muted-foreground">
              {[
                open.proposedMRR > 0 && `${formatCurrency(open.proposedMRR, 0)}/mo`,
                open.proposedAnnual > 0 && `${formatCurrency(open.proposedAnnual, 0)}/yr`,
                open.proposedOneTime > 0 && `${formatCurrency(open.proposedOneTime, 0)} once`,
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              open
            </span>
          ) : undefined
        }
      >
        {upsells.isPending && <p className="px-4 py-2 text-[13px] text-muted-foreground">Loading upsells...</p>}
        {upsells.isError && <p role="alert" className="px-4 py-2 text-[13px] text-destructive">{getErrorMessage(upsells.error)}</p>}
        {upsellRows.length === 0 && upsells.isSuccess && <p className="px-4 py-2 text-[13px] text-muted-foreground">No upsell ideas yet.</p>}
        {upsellRows.map((u) => (
          <UpsellRow
            key={u.id}
            upsell={u}
            serviceLabel={u.service_type ? (catalog.labels.get(u.service_type) ?? u.service_type) : null}
            busy={setUpsellStatus.isPending || removeUpsell.isPending}
            onSetStatus={(status) => void setUpsellStatus.mutateAsync({ id: u.id, status }).catch(() => undefined)}
            onDelete={() => void removeUpsell.mutateAsync(u.id).catch(() => undefined)}
            onAddToPricing={() => setPricingTarget(u)}
          />
        ))}
        <AddUpsellForm
          services={catalog.active}
          busy={addUpsell.isPending}
          onAdd={(input) => addUpsell.mutateAsync({ ...input, contact_id: contact.id }).then(() => true, () => false)}
        />
      </Panel>

      {pricingTarget && (
        <AddToPricingDialog
          upsell={pricingTarget}
          entities={entities}
          services={catalog.active}
          rows={contact.contact_services}
          editing={editing}
          onClose={() => setPricingTarget(null)}
        />
      )}
    </div>
  );
}

type Catalog = ReturnType<typeof useServiceCatalog>;

function EntityQuotes({
  entity,
  entities,
  rows,
  editing,
  catalog,
  header,
}: {
  entity: EntityOption;
  entities: EntityOption[];
  rows: ContactService[];
  editing: QuoteEditing;
  catalog: Catalog;
  header?: React.ReactNode;
}) {
  const occupied = useMemo(() => occupiedByEntity(rows), [rows]);
  const entityRows = rows.filter((r) => r.organization_id === entity.organizationId);
  const available = catalog.active.filter((s) => !occupied.get(entity.organizationId)?.has(s.key));
  const [deleteTarget, setDeleteTarget] = useState<ContactService | null>(null);
  const labelOf = (key: string) => catalog.labels.get(key) ?? key;

  return (
    <section aria-label={`Quotes for ${entity.label}`}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
        <span className="truncate text-[12px] font-semibold">{entity.label}</span>
        {header}
        {available.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="xs" className="ml-auto" disabled={editing.busy}>
                Add service
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {available.map((s) => (
                <DropdownMenuItem
                  key={s.key}
                  onSelect={() =>
                    void editing.addQuote({
                      organization_id: entity.organizationId,
                      service_type: s.key,
                      state: 'proposed',
                      cadence: s.default_cadence,
                      amount: null,
                    })
                  }
                >
                  {s.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {entityRows.length === 0 && <p className="px-4 py-2 text-[12px] text-muted-foreground">No services quoted</p>}
      {entityRows.map((row) => (
        <QuoteRow
          key={row.id}
          row={row}
          label={labelOf(row.service_type)}
          moveTargets={entities.filter((t) => t.organizationId !== row.organization_id)}
          occupied={occupied}
          busy={editing.busy}
          onPatch={(patch) => editing.patchQuote(row, patch)}
          onDeleteRequest={() => setDeleteTarget(row)}
        />
      ))}
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
    </section>
  );
}

function QuoteRow({
  row,
  label,
  moveTargets,
  occupied,
  busy,
  onPatch,
  onDeleteRequest,
}: {
  row: ContactService;
  label: string;
  moveTargets: EntityOption[];
  occupied: Map<string | null, Set<string>>;
  /** The amount stays live; the cadence and state switches wait for the write in flight. */
  busy: boolean;
  onPatch: (patch: QuotePatch) => Promise<boolean>;
  onDeleteRequest: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
      <div className="w-[120px] shrink-0 truncate text-[12px] font-medium text-muted-foreground">{label}</div>
      <EditableField
        type="currency"
        label={`${label} price`}
        value={num(row.amount) > 0 ? row.amount : null}
        className="w-[130px] shrink-0"
        disabled={busy}
        onSave={async (v) => {
          if (!(await onPatch({ amount: v == null ? null : Number(v) }))) throw new Error('not saved');
        }}
      />
      <Segmented<Cadence>
        label={`${label} cadence`}
        value={row.cadence}
        options={CADENCE_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
        onValueChange={(v) => void onPatch({ cadence: v })}
      />
      <Segmented<QuoteState>
        label={`${label} state`}
        value={row.state}
        options={STATE_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
        onValueChange={(v) => void onPatch({ state: v })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={`${label} quote actions`}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {moveTargets.map((t) => {
            const taken = occupied.get(t.organizationId)?.has(row.service_type) ?? false;
            return (
              <DropdownMenuItem key={t.organizationId ?? PERSONAL} disabled={taken || busy} onSelect={() => void onPatch({ organization_id: t.organizationId })}>
                Move to {t.label}
                {taken && <span className="ml-1 text-[10px] text-muted-foreground">(already quoted)</span>}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDeleteRequest}>
            Delete quote
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function UpsellRow({
  upsell,
  serviceLabel,
  busy,
  onSetStatus,
  onDelete,
  onAddToPricing,
}: {
  upsell: ContactUpsell;
  serviceLabel: string | null;
  busy: boolean;
  onSetStatus: (status: UpsellStatus) => void;
  onDelete: () => void;
  onAddToPricing: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const dimmed = upsell.status === 'won' || upsell.status === 'passed';
  const amount = num(upsell.est_amount);
  return (
    <div className={cn('flex flex-wrap items-center gap-3 px-4 py-2', dimmed && 'opacity-60')}>
      <div className="min-w-[140px] flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{upsell.title}</span>
          {serviceLabel && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">{serviceLabel}</span>}
        </div>
        {upsell.notes && <div className="truncate text-[12px] text-muted-foreground">{upsell.notes}</div>}
      </div>
      <span className="shrink-0 text-[13px] font-semibold tabular-nums">
        {amount > 0 ? formatCurrency(amount, 0) : 'No estimate'}
        {amount > 0 && <span className="text-[10px] font-normal text-muted-foreground">{CADENCE_SUFFIX[upsell.cadence] ?? ''}</span>}
      </span>
      <Segmented<UpsellStatus>
        label={`${upsell.title} status`}
        value={upsell.status}
        options={UPSELL_STATUSES.map((s) => ({ value: s, label: UPSELL_LABEL[s], disabled: busy }))}
        onValueChange={onSetStatus}
      />
      {upsell.status === 'won' && (
        <Button type="button" variant="ghost" size="xs" onClick={onAddToPricing}>
          Add to pricing
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${upsell.title}`} onClick={() => setConfirming(true)}>
        <Trash2 aria-hidden="true" />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this upsell?</AlertDialogTitle>
            <AlertDialogDescription>{upsell.title} will be removed from the upsells list.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onDelete}>
              Delete upsell
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const NO_SERVICE = '__none';

function AddUpsellForm({
  services,
  busy,
  onAdd,
}: {
  services: ReadonlyArray<{ key: string; label: string }>;
  busy: boolean;
  onAdd: (input: { title: string; service_type: string | null; est_amount: number | null; cadence: Cadence }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [service, setService] = useState(NO_SERVICE);
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || busy) return;
    const est = parseCurrencyInput(amount);
    if (est !== null && (Number.isNaN(est) || est < 0)) {
      setError('Enter a valid amount.');
      return;
    }
    setError(null);
    const ok = await onAdd({ title: title.trim(), service_type: service === NO_SERVICE ? null : service, est_amount: est, cadence });
    if (ok) {
      setTitle('');
      setAmount('');
      setService(NO_SERVICE);
      setCadence('monthly');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <Input
        aria-label="Upsell title"
        placeholder="Upsell idea"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        className="h-8 min-w-[160px] flex-1 text-[13px]"
      />
      <Select value={service} onValueChange={setService}>
        <SelectTrigger aria-label="Upsell service" className="h-8 w-[150px] text-[13px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SERVICE} className="text-[13px]">No service</SelectItem>
          {services.map((s) => <SelectItem key={s.key} value={s.key} className="text-[13px]">{s.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={cadence} onValueChange={(v) => setCadence(v as Cadence)}>
        <SelectTrigger aria-label="Upsell cadence" className="h-8 w-[120px] text-[13px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {CADENCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-[13px]">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Input
        aria-label="Estimated amount"
        inputMode="decimal"
        placeholder="Estimate"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        className="h-8 w-28 text-[13px]"
      />
      <Button type="button" size="sm" disabled={busy || !title.trim()} onClick={() => void submit()}>
        Add upsell
      </Button>
      {error && <p role="alert" className="w-full text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

/**
 * A won upsell becomes an accepted quote on the chosen person or organization. With no
 * estimate the quote is written unpriced (null), never at 0.
 */
function AddToPricingDialog({
  upsell,
  entities,
  services,
  rows,
  editing,
  onClose,
}: {
  upsell: ContactUpsell;
  entities: EntityOption[];
  services: ReadonlyArray<{ key: string; label: string }>;
  rows: ContactService[];
  editing: QuoteEditing;
  onClose: () => void;
}) {
  const [service, setService] = useState(upsell.service_type ?? services[0]?.key ?? '');
  const [entity, setEntity] = useState(PERSONAL);
  const amount = num(upsell.est_amount) > 0 ? num(upsell.est_amount) : null;

  function confirm() {
    if (!service) return;
    const organizationId = entity === PERSONAL ? null : entity;
    const existing = rows.find((r) => r.service_type === service && r.organization_id === organizationId);
    onClose();
    if (existing) void editing.patchQuote(existing, { amount, state: 'accepted', cadence: upsell.cadence });
    else void editing.addQuote({ organization_id: organizationId, service_type: service, state: 'accepted', cadence: upsell.cadence, amount });
  }

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add to pricing?</AlertDialogTitle>
          <AlertDialogDescription>This accepts the chosen service at this amount on the Pricing card.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>Set</span>
          <Select value={service} onValueChange={setService}>
            <SelectTrigger aria-label="Service" className="h-8 w-[150px] text-[13px]"><SelectValue placeholder="Service" /></SelectTrigger>
            <SelectContent>
              {services.map((s) => <SelectItem key={s.key} value={s.key} className="text-[13px]">{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span>on</span>
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger aria-label="For" className="h-8 w-[160px] text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.organizationId ?? PERSONAL} value={e.organizationId ?? PERSONAL} className="text-[13px]">{e.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>
            {amount != null ? (
              <>
                at <span className="font-semibold tabular-nums">{formatCurrency(amount, 0)}</span>
              </>
            ) : (
              'with no price yet'
            )}
            , accepted?
          </span>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!service} onClick={confirm}>Add to pricing</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
