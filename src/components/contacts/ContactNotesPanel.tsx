import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addContactNote, listContactNotes, NOTE_KINDS, type NoteKind } from '@/api/contactNotes';
import { queryKeys } from '@/api/queryKeys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate } from '@/lib/dates';
import { getErrorMessage } from '@/lib/errors';

const KIND_TEXT: Record<NoteKind, string> = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting' };

/** Notes are a record: they are added, never edited or removed. */
export function ContactNotesPanel({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const notes = useQuery({
    queryKey: queryKeys.contactNotes.forContact(contactId),
    queryFn: () => listContactNotes(contactId),
  });
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<NoteKind>('note');

  const add = useMutation({
    mutationFn: (sent: string) => addContactNote(contactId, sent.trim(), kind),
    onSuccess: (_, sent) => {
      // Clear only the note that was saved, never one typed while it was saving.
      setBody((current) => (current === sent ? '' : current));
      setKind('note');
      void queryClient.invalidateQueries({ queryKey: queryKeys.contactNotes.forContact(contactId) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim() === '' || add.isPending) return;
    add.mutate(body);
  };

  return (
    <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
      <h2 id="notes-heading" className="text-base font-semibold">Notes</h2>
      <form onSubmit={submit} className="flex flex-col gap-2" aria-label="Add note">
        <Label htmlFor="new-note">New note</Label>
        <Textarea id="new-note" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as NoteKind)}>
            <SelectTrigger aria-label="Note type" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {NOTE_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_TEXT[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="submit" size="sm" disabled={body.trim() === '' || add.isPending}>Add note</Button>
        </div>
        {add.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(add.error, 'The note was not saved.')}</p>}
      </form>
      {notes.isPending && <p className="text-sm text-muted-foreground">Loading notes...</p>}
      {notes.isError && <p role="alert" className="text-sm text-destructive">Could not load notes: {getErrorMessage(notes.error)}</p>}
      {notes.data?.length === 0 && <p className="text-sm text-muted-foreground">No notes yet.</p>}
      <ul className="flex flex-col gap-2">
        {notes.data?.map((n) => (
          <li key={n.id} className="rounded-md border p-3 text-sm">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{KIND_TEXT[n.kind] ?? n.kind}</Badge>
              <span>{formatDate(n.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
