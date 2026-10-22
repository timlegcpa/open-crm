import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import {
  addContactNote,
  deleteContactNote,
  listContactNotes,
  NOTE_KINDS,
  updateContactNote,
  type ContactNote,
  type NoteKind,
} from '@/api/contactNotes';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

const KIND_TEXT: Record<NoteKind, string> = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting' };

/** Who wrote a note when it was not the owner. */
const SOURCE_CHIP: Record<string, string> = { mcp: 'Agent', lead_intake: 'Lead intake' };

/**
 * The contact's note log. A note can be corrected in place (its text and its kind) or
 * deleted behind a confirm; who wrote it never changes (0017 grants UPDATE on body and kind
 * only). Every change also refreshes the pipeline cards, which show each lead's newest note.
 * The list has no height cap and no inner scroll; it grows with the page.
 */
export function ContactNotesCard({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const notes = useQuery({ queryKey: queryKeys.contactNotes.forContact(contactId), queryFn: () => listContactNotes(contactId) });
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<NoteKind>('note');
  const [editing, setEditing] = useState<{ id: string; body: string; kind: NoteKind } | null>(null);
  const [deleting, setDeleting] = useState<ContactNote | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.contactNotes.forContact(contactId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.leadNotes() }),
    ]);

  const save = useMutation({
    mutationFn: (e: { id: string; body: string; kind: NoteKind }) => updateContactNote(e.id, { body: e.body.trim(), kind: e.kind }),
    onSuccess: () => setEditing(null),
    onError: (err) => toast.error(getErrorMessage(err, 'The note was not saved.')),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteContactNote(id),
    onSuccess: () => toast.success('Note deleted.'),
    onError: (err) => toast.error(getErrorMessage(err, 'The note was not deleted.')),
    onSettled: () => {
      setDeleting(null);
      return refresh();
    },
  });

  const add = useMutation({
    mutationFn: (sent: string) => addContactNote(contactId, sent.trim(), kind),
    onSuccess: (_, sent) => {
      // Clear only the note that was saved, never one typed while it was saving.
      setBody((current) => (current === sent ? '' : current));
      setKind('note');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The note was not saved.')),
    onSettled: refresh,
  });

  const submit = () => {
    if (body.trim() === '' || add.isPending) return;
    void add.mutateAsync(body).catch(() => undefined);
  };

  return (
    <Panel title="Notes">
      <div className="flex flex-col gap-2 border-b border-border px-3.5 py-3">
        <Textarea
          aria-label="New note"
          placeholder="Add a note"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={10000}
          className="min-h-[64px] text-[13px]"
        />
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as NoteKind)}>
            <SelectTrigger aria-label="Note type" className="h-8 w-32 text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {NOTE_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_TEXT[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" disabled={body.trim() === '' || add.isPending} onClick={submit}>
            Add note
          </Button>
        </div>
      </div>
      <div className="px-3.5 py-3 text-[13px]">
        {notes.isPending && <p className="text-muted-foreground">Loading notes...</p>}
        {notes.isError && <p role="alert" className="text-destructive">Could not load notes: {getErrorMessage(notes.error)}</p>}
        {notes.data?.length === 0 && <p className="text-muted-foreground">No notes yet.</p>}
        {notes.data && notes.data.length > 0 && (
          <ul className="flex flex-col gap-3">
            {notes.data.map((n) => (
              <li key={n.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{KIND_TEXT[n.kind] ?? n.kind}</span>
                  {SOURCE_CHIP[n.source] && (
                    <span className="rounded-full bg-secondary px-1.5 py-px text-[10px] font-medium text-foreground">{SOURCE_CHIP[n.source]}</span>
                  )}
                  <span>{formatDateTime(n.created_at)}</span>
                  {editing?.id !== n.id && (
                    <span className="ml-auto flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label="Edit note"
                        onClick={() => setEditing({ id: n.id, body: n.body, kind: n.kind })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Delete note" onClick={() => setDeleting(n)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  )}
                </div>
                {editing?.id === n.id ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      aria-label="Edit note text"
                      value={editing.body}
                      onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                      maxLength={10000}
                      className="min-h-[64px] text-[13px]"
                    />
                    <div className="flex items-center gap-2">
                      <Select value={editing.kind} onValueChange={(v) => setEditing({ ...editing, kind: v as NoteKind })}>
                        <SelectTrigger aria-label="Edited note type" className="h-8 w-32 text-[13px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {NOTE_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_TEXT[k]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        disabled={editing.body.trim() === '' || save.isPending}
                        onClick={() => void save.mutateAsync(editing).catch(() => undefined)}
                      >
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>The note is removed from the record for good. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) void remove.mutateAsync(deleting.id).catch(() => undefined);
              }}
            >
              Delete note
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
