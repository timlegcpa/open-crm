import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { listPickList, type PickListSpec } from '@/api/pickLists';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToneBadge } from '@/components/ui/tone-badge';
import { cn } from '@/lib/utils';
import {
  deletePickListRow,
  editorListKey,
  insertPickListRow,
  keyFromLabel,
  NothingChangedError,
  pickListKey,
  PickListInUseError,
  updatePickListRow,
  type PickListPatch,
} from './api';

/**
 * One editor for every owner-editable pick-list, in two shapes:
 *   fixed  the code depends on every row (the pipeline stages): label, colour and order
 *          only. No add, no delete, no on/off: the database refuses those, so the screen
 *          never offers a button that can only fail.
 *   open   rows can be added, renamed, recoloured, reordered, turned off, and deleted
 *          while nothing uses them. Built-in (system) rows show no delete and no on/off.
 * A row counts as built in unless it says is_system = false: a list read without that
 * column (or a row that lacks it) hides delete and on/off rather than offering them. The
 * editor reads under its own query key, so a narrower read of the same table elsewhere in
 * the app never stands in for it; a write refreshes both.
 * A key is made from the label when a row is added and never changes. Colour is a
 * lowercase #rrggbb or none; it is drawn as a swatch and a border, with the label in the
 * theme's own text colour, so a colour picked in light mode stays readable in dark.
 */

export interface PickListRow {
  key: string;
  label: string;
  colour: string | null;
  sort_order: number;
  is_active?: boolean;
  is_system?: boolean;
  revenue_family?: 'recurring' | 'one_time';
  default_cadence?: 'monthly' | 'annual' | 'one_time';
}

const FAMILY = [
  { value: 'recurring', label: 'Recurring' },
  { value: 'one_time', label: 'One-time' },
] as const;
const CADENCE = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
  { value: 'one_time', label: 'One-time' },
] as const;

const HEX = /^#[0-9a-f]{6}$/;
const MAX_LABEL = 60;

/** Fail closed: only a row that says is_system = false may be deleted or turned off. */
export const isBuiltIn = (row: PickListRow) => row.is_system !== false;

/** After a write: the editor's own read and every other screen's read of the table. */
function refreshList(queryClient: QueryClient, table: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: editorListKey(table) }),
    queryClient.invalidateQueries({ queryKey: pickListKey(table) }),
  ]);
}

/** What a failed write tells the owner. */
export function pickListErrorMessage(err: unknown): string {
  if (err instanceof PickListInUseError || err instanceof NothingChangedError) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '23505') return 'A row with that name already exists.';
  if (code === '42501') return 'That cannot change on this row.';
  if (code === '23514') return 'That value is not allowed here.';
  return 'The change was not saved. Try again.';
}

export function PickListEditor<Row extends PickListRow>({
  title,
  list,
  shape,
  services = false,
  description,
}: {
  title: string;
  list: PickListSpec<Row>;
  shape: 'fixed' | 'open';
  /** service_types: each row also says whether it is recurring, and how often. */
  services?: boolean;
  description?: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = editorListKey(list.table);
  const { data: rows, isLoading, isError } = useQuery({ queryKey, queryFn: () => listPickList(list) });

  const patch = useMutation({
    mutationFn: ({ key, change }: { key: string; change: PickListPatch }) => updatePickListRow(list, key, change),
    onMutate: async ({ key, change }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Row[]>(queryKey);
      queryClient.setQueryData<Row[]>(queryKey, (old) =>
        (old ?? [])
          .map((r) => (r.key === key ? { ...r, ...change } : r))
          .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key)),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(pickListErrorMessage(err));
    },
    onSettled: () => refreshList(queryClient, list.table),
  });

  const remove = useMutation({
    mutationFn: (key: string) => deletePickListRow(list, key),
    onError: (err) => toast.error(pickListErrorMessage(err)),
    onSettled: () => refreshList(queryClient, list.table),
  });

  const save = (key: string, change: PickListPatch) => patch.mutateAsync({ key, change }).catch(() => undefined);

  /** Moves a row one place, renumbering the list in steps of ten so ties cannot block a move. */
  const move = async (index: number, delta: -1 | 1) => {
    if (!rows) return;
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const order = [...rows];
    [order[index], order[target]] = [order[target], order[index]];
    for (const [i, row] of order.entries()) {
      const next = (i + 1) * 10;
      if (row.sort_order !== next) await save(row.key, { sort_order: next });
    }
  };

  return (
    <Panel title={title} bodyClassName="flex flex-col gap-3 p-3.5">
      {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
      {isLoading && <p className="text-[13px] text-muted-foreground">Loading...</p>}
      {isError && <p role="alert" className="text-[13px] text-destructive">This list could not be loaded.</p>}
      {rows && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={title}>
          {rows.map((row, index) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
              <ColourField label={row.label} value={row.colour} onSave={(colour) => save(row.key, { colour })} />
              <LabelField value={row.label} onSave={(label) => save(row.key, { label })} />
              {shape === 'open' && isBuiltIn(row) && <ToneBadge variant="neutral">Built in</ToneBadge>}
              {shape === 'open' && row.is_active === false && <ToneBadge variant="neutral">Off</ToneBadge>}
              {services && (
                <ServiceFields
                  row={row}
                  disabled={isBuiltIn(row)}
                  onSave={(change) => save(row.key, change)}
                />
              )}
              <div className="ml-auto flex items-center gap-1">
                {shape === 'open' && !isBuiltIn(row) && (
                  <Switch
                    checked={row.is_active !== false}
                    onCheckedChange={(checked) => save(row.key, { is_active: checked })}
                    aria-label={`Offer ${row.label} on new records`}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0 || patch.isPending}
                  onClick={() => void move(index, -1)}
                  aria-label={`Move ${row.label} up`}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === rows.length - 1 || patch.isPending}
                  onClick={() => void move(index, 1)}
                  aria-label={`Move ${row.label} down`}
                >
                  <ArrowDown />
                </Button>
                {shape === 'open' && !isBuiltIn(row) && (
                  <DeleteRow label={row.label} onConfirm={() => remove.mutateAsync(row.key).catch(() => undefined)} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {shape === 'open' && rows && <AddRow list={list} rows={rows} services={services} />}
    </Panel>
  );
}

function LabelField({ value, onSave }: { value: string; onSave: (label: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const shown = editing ? draft : value;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next.length <= MAX_LABEL && next !== value) void onSave(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setDraft(value);
      setEditing(false);
    }
  };

  return (
    <Input
      value={shown}
      maxLength={MAX_LABEL}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      aria-label={`Name of ${value}`}
      className="h-8 min-w-0 flex-1 basis-40 text-[13px]"
    />
  );
}

function ColourField({ label, value, onSave }: { label: string; value: string | null; onSave: (colour: string | null) => Promise<unknown> }) {
  return (
    <span className="flex items-center gap-1">
      <input
        type="color"
        value={value ?? '#71717a'}
        onChange={(e) => {
          const next = e.target.value.toLowerCase();
          if (HEX.test(next) && next !== value) void onSave(next);
        }}
        aria-label={`Colour of ${label}`}
        className={cn(
          'h-6 w-6 cursor-pointer rounded-md border border-border bg-transparent p-0.5',
          !value && 'opacity-40',
        )}
      />
    </span>
  );
}

function ServiceFields({
  row,
  disabled,
  onSave,
}: {
  row: PickListRow;
  disabled: boolean;
  onSave: (change: PickListPatch) => Promise<unknown>;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Select
        value={row.revenue_family}
        disabled={disabled}
        onValueChange={(value) => void onSave({ revenue_family: value as PickListRow['revenue_family'] })}
      >
        <SelectTrigger className="h-8 w-[118px] text-[13px]" aria-label={`Revenue type of ${row.label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FAMILY.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={row.default_cadence}
        disabled={disabled}
        onValueChange={(value) => void onSave({ default_cadence: value as PickListRow['default_cadence'] })}
      >
        <SelectTrigger className="h-8 w-[108px] text-[13px]" aria-label={`Billing cadence of ${row.label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CADENCE.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

function DeleteRow({ label, onConfirm }: { label: string; onConfirm: () => Promise<unknown> }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${label}`}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Only a row nothing uses can be deleted. If records use it, turn it off instead: it stays on those records and is
            not offered for new ones.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddRow<Row extends PickListRow>({ list, rows, services }: { list: PickListSpec<Row>; rows: Row[]; services: boolean }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [family, setFamily] = useState<'recurring' | 'one_time'>('recurring');
  const [cadence, setCadence] = useState<'monthly' | 'annual' | 'one_time'>('monthly');
  const key = keyFromLabel(label);
  const taken = key !== null && rows.some((r) => r.key === key);

  const add = useMutation({
    mutationFn: () =>
      insertPickListRow(list, {
        key: key!,
        label: label.trim(),
        colour: null,
        sort_order: (rows.reduce((max, r) => Math.max(max, r.sort_order), 0) || 0) + 10,
        ...(services ? { revenue_family: family, default_cadence: cadence } : {}),
      }),
    onSuccess: () => setLabel(''),
    onError: (err) => toast.error(pickListErrorMessage(err)),
    onSettled: () => refreshList(queryClient, list.table),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!key || taken || add.isPending) return;
    void add.mutateAsync().catch(() => undefined);
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        value={label}
        maxLength={MAX_LABEL}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="New entry"
        aria-label="Name of the new entry"
        className="h-8 min-w-0 flex-1 basis-40 text-[13px]"
      />
      {services && (
        <>
          <Select value={family} onValueChange={(v) => setFamily(v as typeof family)}>
            <SelectTrigger className="h-8 w-[118px] text-[13px]" aria-label="Revenue type of the new entry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FAMILY.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cadence} onValueChange={(v) => setCadence(v as typeof cadence)}>
            <SelectTrigger className="h-8 w-[108px] text-[13px]" aria-label="Billing cadence of the new entry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCE.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <Button type="submit" size="sm" disabled={!key || taken || add.isPending}>
        Add
      </Button>
      {label.trim() !== '' && !key && <p className="w-full text-xs text-muted-foreground">Start the name with a letter.</p>}
      {taken && <p className="w-full text-xs text-muted-foreground">There is already an entry with that name.</p>}
    </form>
  );
}
