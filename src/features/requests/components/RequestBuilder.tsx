import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, FileText, Plus, Trash2 } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { links } from '@/features/links';
import { usePickList } from '@/hooks/usePickLists';
import { getErrorMessage } from '@/lib/errors';
import {
  createDraft,
  deleteTemplate,
  listDraftIds,
  listTemplates,
  REQUEST_CATEGORIES,
  REQUEST_TAGS,
  saveTemplate,
  sendRequest,
  updateDraft,
  type DraftInput,
} from '../api';
import { requestKeys } from '../keys';
import {
  draftProblem,
  ITEM_KINDS,
  KIND_LABELS,
  LIMITS,
  newDraftItem,
  sendProblem,
  toDraftItems,
  type DraftItem,
  type ItemKind,
  type RequestWithItems,
} from '../lib/requests';
import { RequestPreview } from './RequestPreview';

/**
 * The request builder: a new request for a contact, or a draft being edited. Items are
 * edited in place (kind, label, details, required, sensitive for a question, category and
 * tag). Save keeps it a draft; Save and send saves, then sends through send-needs-list,
 * which publishes only the version it read.
 */
export function RequestBuilder({ contactId, contactName, draft }: { contactId: string; contactName: string; draft?: RequestWithItems }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const categories = usePickList(REQUEST_CATEGORIES);
  const tags = usePickList(REQUEST_TAGS);
  const known = useMemo(
    () => ({
      categories: new Set((categories.data ?? []).map((r) => r.key)),
      tags: new Set((tags.data ?? []).map((r) => r.key)),
    }),
    [categories.data, tags.data],
  );

  const [title, setTitle] = useState(draft?.title ?? '');
  const [intro, setIntro] = useState(draft?.intro_message ?? '');
  const [confirmDetails, setConfirmDetails] = useState(draft?.include_contact_confirm ?? false);
  const [items, setItems] = useState<DraftItem[]>(() =>
    draft
      ? draft.items.map((i) => ({
          kind: i.kind,
          label: i.label,
          description: i.description ?? '',
          required: i.required,
          sensitive: i.sensitive,
          category: i.category,
          tag: i.tag,
        }))
      : [newDraftItem('document')],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const otherDrafts = useQuery({
    queryKey: requestKeys.drafts(contactId),
    queryFn: () => listDraftIds(contactId),
    enabled: !draft,
  });
  const templates = useQuery({ queryKey: requestKeys.templates(), queryFn: listTemplates });

  const input = (): DraftInput => ({ title, intro, includeContactConfirm: confirmDetails, items });
  const refresh = () => queryClient.invalidateQueries({ queryKey: requestKeys.all });

  const save = useMutation({
    mutationFn: async (send: boolean) => {
      const blocked = draftProblem(title, items, intro) ?? (send ? sendProblem(items) : null);
      if (blocked) throw new Error(blocked);
      const id = draft ? (await updateDraft({ id: draft.id, contactId: draft.contact_id, contentVersion: draft.content_version }, input()), draft.id) : await createDraft(contactId, input());
      if (!send) return { id, sent: null, sendError: null };
      try {
        return { id, sent: await sendRequest(id), sendError: null };
      } catch (err) {
        // Saved as a draft either way: say so, then open it.
        return { id, sent: null, sendError: getErrorMessage(err) };
      }
    },
    onMutate: () => setProblem(null),
    onSuccess: ({ id, sent, sendError }) => {
      void refresh();
      if (sendError) {
        toast.error(`Saved as a draft, but not sent: ${sendError}`);
      } else if (sent) {
        if (sent.email_sent === false) toast.warning('Sent. The email did not go out; the client can still see it in the portal. Use Remind to try again.');
        else if (sent.email_sent === null) toast.success('Sent. The email may not have gone out; check with the client if they do not see it.');
        else toast.success(sent.start_link ? 'Sent, with a link to set up portal access.' : 'Sent.');
      } else {
        toast.success('Draft saved.');
      }
      navigate(links.request(id), { replace: true });
    },
    onError: (err) => setProblem(getErrorMessage(err, 'The request was not saved. Try again.')),
  });

  const update = (index: number, change: Partial<DraftItem>) =>
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const move = (index: number, by: -1 | 1) =>
    setItems((rows) => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  const applyTemplate = (id: string) => {
    const template = templates.data?.find((t) => t.id === id);
    if (!template) return;
    if (!title.trim()) setTitle(template.name.slice(0, LIMITS.title));
    if (!intro.trim() && template.intro_message) setIntro(template.intro_message);
    if (template.include_contact_confirm) setConfirmDetails(true);
    const added = toDraftItems(template.items, known);
    setItems((rows) => [...rows.filter((r) => r.label.trim() !== ''), ...added]);
    toast.success(`Added ${added.length} ${added.length === 1 ? 'item' : 'items'} from ${template.name}.`);
  };

  const removeTemplate = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: requestKeys.templates() }),
    onError: (err) => toast.error(getErrorMessage(err, 'The template was not deleted.')),
  });

  const busy = save.isPending;
  const hasOtherDraft = !draft && (otherDrafts.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4">
      {hasOtherDraft && (
        <Alert>
          <AlertDescription>
            {contactName} already has a draft request.{' '}
            <Link className="underline underline-offset-2" to={links.request(otherDrafts.data![0])}>
              Open the draft
            </Link>{' '}
            to keep working on it, or carry on to start another.
          </AlertDescription>
        </Alert>
      )}

      <Panel
        title="Request"
        action={
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="ghost" disabled={!templates.data?.length}>
                  <FileText aria-hidden /> Templates
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Add items from a template</DropdownMenuLabel>
                {(templates.data ?? []).map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => applyTemplate(t.id)}>
                    <span className="truncate">{t.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Delete a template</DropdownMenuLabel>
                {(templates.data ?? []).map((t) => (
                  <DropdownMenuItem key={`del-${t.id}`} onSelect={() => removeTemplate.mutate(t.id)} className="text-destructive">
                    <Trash2 aria-hidden /> <span className="truncate">{t.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="xs" variant="ghost" onClick={() => setTemplateOpen(true)} disabled={items.length === 0}>
              Save as template
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setPreviewing((v) => !v)} aria-pressed={previewing}>
              <Eye aria-hidden /> {previewing ? 'Edit' : 'Preview'}
            </Button>
          </div>
        }
        bodyClassName="flex flex-col gap-4 p-4"
      >
        {previewing ? (
          <RequestPreview title={title} intro={intro} items={items} includeContactConfirm={confirmDetails} />
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">For {contactName}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request-title">Title</Label>
              <Input id="request-title" value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} placeholder="Onboarding documents" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request-intro">Message to the client (optional)</Label>
              <Textarea id="request-intro" value={intro} maxLength={LIMITS.intro} rows={3} onChange={(e) => setIntro(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="request-confirm" checked={confirmDetails} onCheckedChange={setConfirmDetails} />
              <Label htmlFor="request-confirm" className="font-normal">
                Ask the client to confirm their contact details
              </Label>
            </div>
          </>
        )}
      </Panel>

      {!previewing && (
        <Panel
          title={`Items (${items.length})`}
          action={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline">
                  <Plus aria-hidden /> Add item
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ITEM_KINDS.map((kind) => (
                  <DropdownMenuItem key={kind} onSelect={() => setItems((rows) => [...rows, newDraftItem(kind)])}>
                    {KIND_LABELS[kind]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
          bodyClassName="divide-y divide-border"
        >
          {items.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No items yet. Add what you need from the client.</p>}
          {items.map((item, index) => (
            <ItemEditor
              key={index}
              index={index}
              item={item}
              count={items.length}
              categories={categories.data ?? []}
              tags={tags.data ?? []}
              onChange={(change) => update(index, change)}
              onMove={(by) => move(index, by)}
              onRemove={() => setItems((rows) => rows.filter((_, i) => i !== index))}
            />
          ))}
        </Panel>
      )}

      {problem && (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => save.mutate(true)} disabled={busy}>
          {busy ? 'Saving...' : 'Save and send'}
        </Button>
        <Button variant="outline" onClick={() => save.mutate(false)} disabled={busy}>
          Save draft
        </Button>
        <Button variant="ghost" onClick={() => navigate(-1)} disabled={busy}>
          Cancel
        </Button>
      </div>

      <SaveTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} input={input()} defaultName={title} />
    </div>
  );
}

function ItemEditor({
  index,
  item,
  count,
  categories,
  tags,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  item: DraftItem;
  count: number;
  categories: { key: string; label: string; is_active: boolean }[];
  tags: { key: string; label: string; is_active: boolean }[];
  onChange: (change: Partial<DraftItem>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const id = `request-item-${index}`;
  const options = (rows: { key: string; label: string; is_active: boolean }[], current: string) =>
    rows.filter((r) => r.is_active || r.key === current);
  return (
    <div className="flex flex-col gap-3 px-4 py-3" role="group" aria-label={`Item ${n}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={item.kind}
          onValueChange={(kind: ItemKind) =>
            onChange({ kind, sensitive: kind === 'question' ? item.sensitive : false, required: kind === 'info' ? false : item.required })
          }
        >
          <SelectTrigger className="h-8 w-44 text-xs" aria-label={`Item ${n} kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEM_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={item.category} onValueChange={(category) => onChange({ category })}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label={`Item ${n} category`}>
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            {options(categories, item.category).map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={item.tag} onValueChange={(tag) => onChange({ tag })}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Item ${n} tag`}>
            <SelectValue placeholder="Tag" />
          </SelectTrigger>
          <SelectContent>
            {options(tags, item.tag).map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={`Move item ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Move item ${n} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Remove item ${n}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-label`}>{item.kind === 'info' ? 'Note' : 'What you need'}</Label>
        <Input id={`${id}-label`} value={item.label} maxLength={LIMITS.label} onChange={(e) => onChange({ label: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-details`}>Details (optional)</Label>
        <Textarea id={`${id}-details`} rows={2} value={item.description} maxLength={LIMITS.description} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-4">
        {item.kind !== 'info' && (
          <div className="flex items-center gap-2">
            <Switch id={`${id}-required`} checked={item.required} onCheckedChange={(required) => onChange({ required })} />
            <Label htmlFor={`${id}-required`} className="font-normal">
              Required
            </Label>
          </div>
        )}
        {item.kind === 'question' && (
          <div className="flex items-center gap-2">
            <Switch id={`${id}-sensitive`} checked={item.sensitive} onCheckedChange={(sensitive) => onChange({ sensitive })} />
            <Label htmlFor={`${id}-sensitive`} className="font-normal">
              Sensitive: store the answer encrypted
            </Label>
          </div>
        )}
      </div>
    </div>
  );
}

function SaveTemplateDialog({
  open,
  onOpenChange,
  input,
  defaultName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: DraftInput;
  defaultName: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('Give the template a name.');
      const blocked = draftProblem(name, input.items, input.intro);
      if (blocked) throw new Error(blocked);
      return saveTemplate(name, input);
    },
    onSuccess: () => {
      toast.success('Template saved.');
      void queryClient.invalidateQueries({ queryKey: requestKeys.templates() });
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(defaultName.slice(0, LIMITS.templateName));
        save.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>The items and message, to start a request from next time. Answers are never saved.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-name">Template name</Label>
          <Input id="template-name" value={name} maxLength={LIMITS.templateName} onChange={(e) => setName(e.target.value)} />
        </div>
        {save.error && (
          <p role="alert" className="text-[13px] text-destructive">
            {getErrorMessage(save.error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
