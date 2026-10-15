import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContactService } from '@/api/contacts';
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
import { useServiceTypes } from '@/hooks/usePickLists';
import { formatCurrency } from '@/lib/format';
import { listOrganizationsForContact, type Organization } from '../../api';
import { crmKeys } from '../../keys';
import { toAmount } from '../../lib/board';

export type Cadence = ContactService['cadence'];
export type QuoteState = ContactService['state'];

export const CADENCE_OPTIONS: ReadonlyArray<{ value: Cadence; label: string }> = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Yearly' },
  { value: 'one_time', label: 'One-time' },
];

export const STATE_OPTIONS: ReadonlyArray<{ value: QuoteState; label: string }> = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'accepted', label: 'Accepted' },
];

/** Who a quote is for: the person (null) or one of their organizations. */
export interface EntityOption {
  organizationId: string | null;
  label: string;
}

/** A contact's organizations, cached under the contacts prefix. */
export function useContactOrganizations(contactId: string) {
  return useQuery({ queryKey: crmKeys.organizations(contactId), queryFn: () => listOrganizationsForContact(contactId) });
}

export function entityOptionsOf(organizations: readonly Organization[]): EntityOption[] {
  return [{ organizationId: null, label: 'Personal' }, ...organizations.map((o) => ({ organizationId: o.id, label: o.name }))];
}

/** Service types already quoted per entity: the table allows one quote per (contact, entity, service). */
export function occupiedByEntity(rows: readonly ContactService[]): Map<string | null, Set<string>> {
  const map = new Map<string | null, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.organization_id)) map.set(r.organization_id, new Set());
    map.get(r.organization_id)!.add(r.service_type);
  }
  return map;
}

/** Service labels by key, with the active service types offered for a new quote. */
export function useServiceCatalog() {
  const services = useServiceTypes();
  return useMemo(() => {
    const rows = services.data ?? [];
    return {
      labels: new Map(rows.map((s) => [s.key, s.label])),
      active: rows.filter((s) => s.is_active),
      byKey: new Map(rows.map((s) => [s.key, s])),
    };
  }, [services.data]);
}

/** The price as a line shows it. NULL and 0 are "no price agreed". */
export function priceLabel(row: Pick<ContactService, 'amount' | 'cadence'>): string {
  const n = toAmount(row.amount);
  if (n == null) return 'Set price';
  const money = formatCurrency(n, 0);
  if (row.cadence === 'monthly') return `${money}/mo`;
  if (row.cadence === 'annual') return `${money}/yr`;
  return `${money} once`;
}

export function QuoteDeleteDialog({
  target,
  label,
  onCancel,
  onConfirm,
}: {
  target: ContactService | null;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const amount = target ? toAmount(target.amount) : null;
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this quote?</AlertDialogTitle>
          <AlertDialogDescription>
            {target ? `${label}${amount != null ? ` at ${formatCurrency(amount, 0)}` : ''} will be removed from pricing.` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>
            Delete quote
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
