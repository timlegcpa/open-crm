import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, Loader2, Save, Trash2 } from 'lucide-react';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { getErrorMessage } from '@/lib/errors';
import { applyTemplateToEnvelope, listTemplates, saveTemplateFromEnvelope, softDeleteTemplate } from '../api';
import { REASON_MAX, TEMPLATE_NAME_MAX, type TemplateRow, type TemplateScope } from '../contract';
import { esignKeys } from '../keys';

/**
 * Field layouts saved by role. Applying one places the primary signer's fields and, with a
 * co-signer on the envelope, the co-signer's too; the server skips pages the envelope does
 * not have and reports how many.
 */
export function TemplateControls({
  envelopeId,
  hasCoSigner,
  onBeforeTemplateAction,
}: {
  envelopeId: string;
  hasCoSigner: boolean;
  /** Saves pending placements first, so a template captures (or lands on) the latest layout. */
  onBeforeTemplateAction: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TemplateRow | null>(null);
  const templates = useQuery({ queryKey: esignKeys.templates, queryFn: listTemplates });

  const apply = useMutation({
    mutationFn: async (vars: { template_id: string; scope: TemplateScope }) => {
      await onBeforeTemplateAction();
      return applyTemplateToEnvelope({ envelope_id: envelopeId, ...vars });
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.fields(envelopeId) });
      const skipped = res.skipped_count > 0 ? ` ${res.skipped_count} skipped: the envelope has fewer pages than the template.` : '';
      toast.success(`${res.inserted_count} field${res.inserted_count === 1 ? '' : 's'} placed.${skipped}`);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The template was not applied. Try again.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => softDeleteTemplate(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.templates });
      toast.success('Template deleted.');
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The template was not deleted. Try again.')),
  });

  const list = templates.data ?? [];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline">
            <FileStack aria-hidden="true" />
            Templates
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Apply a template</DropdownMenuLabel>
          {templates.isPending && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading...</p>}
          {templates.isError && <p className="px-2 py-1.5 text-xs text-destructive">Could not load templates.</p>}
          {templates.isSuccess && list.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No templates yet.</p>}
          {list.map((t) => (
            <DropdownMenuSub key={t.id}>
              <DropdownMenuSubTrigger className="flex items-center justify-between gap-2">
                <span className="truncate">{t.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t.page_count} page{t.page_count === 1 ? '' : 's'}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem disabled={apply.isPending} onSelect={() => apply.mutate({ template_id: t.id, scope: 'primary_only' })}>
                  Primary signer only
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={apply.isPending || !hasCoSigner}
                  onSelect={() => apply.mutate({ template_id: t.id, scope: 'with_co_signer' })}
                >
                  Primary and co-signer
                  {!hasCoSigner && <span className="ml-1 text-xs text-muted-foreground">(no co-signer)</span>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteTarget(t)}>
                  <Trash2 aria-hidden="true" />
                  Delete template
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
            <Save aria-hidden="true" />
            Save this layout as a template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {saveOpen && <SaveTemplateDialog envelopeId={envelopeId} onBeforeSave={onBeforeTemplateAction} onClose={() => setSaveOpen(false)} />}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && !remove.isPending && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `${deleteTarget.name} leaves the template list. Envelopes it was applied to keep their fields.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) remove.mutate(deleteTarget.id);
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SaveTemplateDialog({
  envelopeId,
  onBeforeSave,
  onClose,
}: {
  envelopeId: string;
  onBeforeSave: () => Promise<void>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await onBeforeSave();
      return saveTemplateFromEnvelope({ envelope_id: envelopeId, name: name.trim(), description: description.trim() || undefined });
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.templates });
      toast.success(`Template saved with ${res.field_count} field${res.field_count === 1 ? '' : 's'}.`);
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The template was not saved. Try again.')),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this layout as a template</DialogTitle>
          <DialogDescription>
            Keeps the primary signer’s and co-signer’s field positions. Apply it to a later envelope to skip placing them by hand.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-template-name">Name</Label>
            <Input
              id="esign-template-name"
              placeholder="Engagement letter"
              value={name}
              maxLength={TEMPLATE_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-template-description">Description (optional)</Label>
            <Textarea
              id="esign-template-description"
              value={description}
              maxLength={REASON_MAX}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Save template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
