import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { useContactCandidates } from '@/hooks/useContactCandidates';
import { getErrorMessage } from '@/lib/errors';
import {
  boardKeys,
  createWorkItem,
  DEFAULT_WORK_ITEM_TYPE,
  type BoardStageKey,
  type WorkItemPriority,
} from '../api';
import { EVENT_NOTE_MAX, WORK_ITEM_PRIORITIES, WORK_ITEM_TITLE_MAX } from '../board';
import { useBoardStages, useWorkItemTypes } from '../hooks';

interface PickedContact {
  id: string;
  name: string;
}

/**
 * Add work item: title, optional contact, type, the lane it starts in, priority, optional
 * due date and an optional starting note. One write: create_work_item makes the card and
 * records where it started, with the note, so a card never exists without that line.
 */
export function AddWorkItemDialog({
  open,
  onOpenChange,
  defaultStage = 'todo',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The lane it starts in; a lane's own add button passes its stage. */
  defaultStage?: BoardStageKey;
}) {
  const queryClient = useQueryClient();
  const { columns } = useBoardStages();
  const { query: typesQuery } = useWorkItemTypes();
  const activeTypes = (typesQuery.data ?? []).filter((t) => t.is_active);
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState<BoardStageKey>(defaultStage);
  const [type, setType] = useState(DEFAULT_WORK_ITEM_TYPE);
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<WorkItemPriority>('normal');
  const [dueDate, setDueDate] = useState('');

  // The dialog stays mounted between opens, so the lane it was opened from is applied on
  // each open, not only at mount.
  useEffect(() => {
    if (open) setStage(defaultStage);
  }, [open, defaultStage]);

  const reset = () => {
    setTitle('');
    setStage(defaultStage);
    setType(DEFAULT_WORK_ITEM_TYPE);
    setContact(null);
    setNote('');
    setPriority('normal');
    setDueDate('');
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createWorkItem({
        title: title.trim(),
        contact_id: contact?.id ?? null,
        work_item_type: type,
        stage,
        priority,
        due_date: dueDate === '' ? null : dueDate,
        note: note.trim(),
      }),
    onSuccess: () => {
      toast.success('Work item added.');
      reset();
      onOpenChange(false);
    },
    onError: (err) => toast.error('Could not add the work item.', { description: getErrorMessage(err, 'Please try again.') }),
    // Cards and history both: the creation lands in history.
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });

  const canSave = title.trim() !== '' && !createMutation.isPending;

  // One close path, so a reopen never shows the last draft.
  const handleOpenChange = (next: boolean) => {
    if (createMutation.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add work item</DialogTitle>
          <DialogDescription>Goes on the board.</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) createMutation.mutateAsync().catch(() => undefined);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="work-item-title">Title</Label>
            <Input
              id="work-item-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={WORK_ITEM_TITLE_MAX}
              placeholder="What needs doing"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="work-item-contact">Contact</Label>
            <ContactSearchField contact={contact} onChange={setContact} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="work-item-type">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="work-item-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(activeTypes.length > 0 ? activeTypes : [{ key: DEFAULT_WORK_ITEM_TYPE, label: 'Task' }]).map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-stage">Lane</Label>
              <Select value={stage} onValueChange={(v) => setStage(v as BoardStageKey)}>
                <SelectTrigger id="work-item-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((col) => (
                    <SelectItem key={col.stage} value={col.stage}>
                      {col.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-priority">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as WorkItemPriority)}>
                <SelectTrigger id="work-item-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ITEM_PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-due">Due date</Label>
              <DatePicker id="work-item-due" value={dueDate} onChange={setDueDate} placeholder="Optional" className="w-full" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="work-item-note">Starting note</Label>
            <Textarea
              id="work-item-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={EVENT_NOTE_MAX}
              placeholder="Optional. Lands in the card's history."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={createMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {createMutation.isPending ? 'Adding...' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The contact field is a type-to-search box, not a button that opens one: the search runs
 * straight from the field. It reads the shared contact candidates (the contacts list's own
 * search rule and names). Typing searches; a pick fills the box with the name and closes
 * the list; editing the text again drops the pick; the X clears both. `onMouseDown` on the
 * list keeps the input's focus through a click on a row, so the click lands before the blur
 * would hide the list.
 */
function ContactSearchField({ contact, onChange }: { contact: PickedContact | null; onChange: (c: PickedContact | null) => void }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listOpen = focused && contact === null;
  const { contacts, candidates } = useContactCandidates(query, listOpen);

  return (
    <Command
      shouldFilter={false}
      label="Contact"
      // The box is the Input's shape. cmdk's input wrapper draws a bottom border meant for a
      // list beneath it, which here would be a stray line inside the field.
      className="relative h-auto overflow-visible rounded-md border border-input bg-transparent text-foreground focus-within:ring-1 focus-within:ring-ring [&_[cmdk-input-wrapper]]:flex-1 [&_[cmdk-input-wrapper]]:border-0"
    >
      <div className="flex items-center">
        <CommandInput
          ref={inputRef}
          id="work-item-contact"
          placeholder="Anyone in the CRM, or no one"
          className="h-9 text-[13px]"
          value={contact ? contact.name : query}
          onValueChange={(v) => {
            setQuery(v);
            if (contact) onChange(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {contact && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0"
            aria-label="Clear contact"
            onClick={() => {
              onChange(null);
              setQuery('');
            }}
          >
            <X />
          </Button>
        )}
      </div>
      {listOpen && (
        <CommandList
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover shadow-md"
          onMouseDown={(e) => e.preventDefault()}
        >
          {contacts.isPending ? (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">Loading contacts...</div>
          ) : contacts.isError ? (
            <div role="alert" className="px-3 py-2 text-[13px] text-destructive">
              Could not load contacts.
            </div>
          ) : (
            <>
              <CommandEmpty>No contacts match.</CommandEmpty>
              {candidates.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    onChange({ id: c.id, name: c.name });
                    setQuery('');
                    inputRef.current?.blur();
                  }}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{c.name}</span>
                    {c.detail && <span className="truncate text-[11px] text-muted-foreground">{c.detail}</span>}
                  </span>
                </CommandItem>
              ))}
            </>
          )}
        </CommandList>
      )}
    </Command>
  );
}
