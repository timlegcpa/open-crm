import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { queryKeys } from '@/api/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { useOrganizationTypes } from '@/hooks/usePickLists';
import { getErrorMessage } from '@/lib/errors';
import {
  createOrganization,
  getOrganization,
  listOrganizationsForContact,
  updateOrganization,
  type Organization,
  type OrganizationPatch,
} from '../api';
import { allowedOrganizationStatusTargets, findOrganizationNameClash, ORGANIZATION_STATUS_LABELS } from '../lib/organizations';

export interface OrganizationDraft {
  name: string;
  organization_type: string;
  tax_id: string;
  status: string;
}

/** A refused status move; its message is shown as is. */
export class OrganizationStatusError extends Error {}

/**
 * THE way an organization is created or edited from the CRM. Create re-reads the contact's
 * organizations fresh and refuses a repeated name. Update sends ONLY the fields the owner
 * changed, each compared with the snapshot the popover took when it opened (never the
 * live prop, which a refetch can move mid-edit), so a pure rename never rewrites status
 * or anything else. A status change is re-checked against the fresh row's status.
 */
export function useOrganizationMutations(contactId: string) {
  const queryClient = useQueryClient();
  // Every organization key nests under the contacts prefix.
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });

  const create = useMutation({
    mutationFn: async (draft: OrganizationDraft) => {
      const existing = await listOrganizationsForContact(contactId);
      const clash = findOrganizationNameClash(existing, draft.name);
      if (clash) throw new Error(`${clash.name} is already on this contact. Quote it instead of adding a second record.`);
      return createOrganization({
        contact_id: contactId,
        name: draft.name.trim(),
        organization_type: draft.organization_type,
        tax_id: draft.tax_id.trim() || null,
      });
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The organization was not added.')),
    onSettled: refresh,
  });

  const update = useMutation({
    mutationFn: async ({ id, draft, opened }: { id: string; draft: OrganizationDraft; opened: OrganizationDraft }) => {
      const fresh = await getOrganization(id);
      if (!fresh) throw new Error('This organization no longer exists.');
      const patch: OrganizationPatch = {};
      if (draft.name.trim() !== opened.name.trim()) patch.name = draft.name.trim();
      if (draft.organization_type !== opened.organization_type) patch.organization_type = draft.organization_type;
      if (draft.tax_id.trim() !== opened.tax_id.trim()) patch.tax_id = draft.tax_id.trim() || null;
      if (draft.status !== opened.status && draft.status !== fresh.status) {
        if (!allowedOrganizationStatusTargets(fresh.status).includes(draft.status)) {
          throw new OrganizationStatusError(`A ${fresh.status} organization cannot be set to ${draft.status}.`);
        }
        patch.status = draft.status;
      }
      if (Object.keys(patch).length === 0) return fresh;
      return updateOrganization(id, patch);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The organization was not saved.')),
    onSettled: refresh,
  });

  return {
    create: (draft: OrganizationDraft) => create.mutateAsync(draft).then(() => true, () => false),
    creating: create.isPending,
    /** `opened` is the snapshot the editor took when it opened. */
    update: (organization: Pick<Organization, 'id'>, draft: OrganizationDraft, opened: OrganizationDraft) =>
      update.mutateAsync({ id: organization.id, draft, opened }).then(() => true, () => false),
    isSaving: (id: string) => update.isPending && update.variables?.id === id,
  };
}

function OrganizationFields({
  idPrefix,
  draft,
  onChange,
  onEnter,
  statusOptions,
}: {
  idPrefix: string;
  draft: OrganizationDraft;
  onChange: (next: OrganizationDraft) => void;
  onEnter: () => void;
  statusOptions?: string[];
}) {
  const types = useOrganizationTypes();
  const typeOptions = (types.data ?? []).filter((t) => t.is_active || t.key === draft.organization_type);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-name`} className="text-[12px]">Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
          className="h-8 text-[13px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-type`} className="text-[12px]">Type</Label>
        <Select value={draft.organization_type} onValueChange={(v) => onChange({ ...draft, organization_type: v })}>
          <SelectTrigger id={`${idPrefix}-type`} className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => <SelectItem key={t.key} value={t.key} className="text-[13px]">{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-tax-id`} className="text-[12px]">Tax ID</Label>
        <Input
          id={`${idPrefix}-tax-id`}
          value={draft.tax_id}
          maxLength={40}
          onChange={(e) => onChange({ ...draft, tax_id: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
          className="h-8 text-[13px]"
        />
      </div>
      {statusOptions && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-status`} className="text-[12px]">Status</Label>
          <Select value={draft.status} onValueChange={(v) => onChange({ ...draft, status: v })} disabled={statusOptions.length <= 1}>
            <SelectTrigger id={`${idPrefix}-status`} className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusOptions.map((s) => <SelectItem key={s} value={s} className="text-[13px]">{ORGANIZATION_STATUS_LABELS[s] ?? s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

const EMPTY: OrganizationDraft = { name: '', organization_type: 'other', tax_id: '', status: 'prospect' };

export function AddOrganizationPopover({ onCreate, creating }: { onCreate: (draft: OrganizationDraft) => Promise<boolean>; creating: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OrganizationDraft>(EMPTY);
  async function submit() {
    if (!draft.name.trim() || creating) return;
    // Close and clear only on a real create; a refusal keeps what was typed.
    if (!(await onCreate(draft))) return;
    setOpen(false);
    setDraft(EMPTY);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs">
          <Plus aria-hidden="true" />
          Add organization
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[280px] flex-col gap-3 p-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">New organization</div>
        <OrganizationFields idPrefix="new-org" draft={draft} onChange={setDraft} onEnter={() => void submit()} />
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" size="xs" disabled={creating || !draft.name.trim()} onClick={() => void submit()}>Add</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EditOrganizationPopover({
  organization,
  onSave,
  saving,
}: {
  organization: Organization;
  /** `opened` is the snapshot taken when the popover opened. */
  onSave: (draft: OrganizationDraft, opened: OrganizationDraft) => Promise<boolean>;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fromRow = (): OrganizationDraft => ({
    name: organization.name,
    organization_type: organization.organization_type,
    tax_id: organization.tax_id ?? '',
    status: organization.status,
  });
  const [draft, setDraft] = useState<OrganizationDraft>(fromRow);
  const [opened, setOpened] = useState<OrganizationDraft>(fromRow);
  async function submit() {
    if (!draft.name.trim() || saving) return;
    if (!(await onSave(draft, opened))) return;
    setOpen(false);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Seed on OPEN, never from an effect: a refetch mid-edit must not wipe the draft.
        if (next) {
          const snapshot = fromRow();
          setDraft(snapshot);
          setOpened(snapshot);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Edit ${organization.name}`}>
          <Pencil aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[300px] flex-col gap-3 p-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Edit organization</div>
        <OrganizationFields
          idPrefix={`org-${organization.id}`}
          draft={draft}
          onChange={setDraft}
          onEnter={() => void submit()}
          statusOptions={allowedOrganizationStatusTargets(opened.status)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" size="xs" disabled={saving || !draft.name.trim()} onClick={() => void submit()}>Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
