import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addContactNote, listContactNotes, NOTE_KINDS, type NoteKind } from '@/api/contactNotes';
import { queryKeys } from '@/api/queryKeys';
import { Panel } from '@/components/layout/page';
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
 * Notes are a record: added, never edited or removed (the table grants SELECT and INSERT
 * only). The list has no height cap and no inner scroll; it grows with the page.
 */
export function ContactNotesCard({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const notes = useQuery({ queryKey: queryKeys.contactNotes.forContact(contactId), queryFn: () => listContactNotes(contactId) });
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<NoteKind>('note');

  const add = useMutation({
    mutationFn: (sent: string) => addContactNote(contactId, sent.trim(), kind),
    onSuccess: (_, sent) => {
      // Clear only the note that was saved, never one typed while it was saving.
      setBody((current) => (current === sent ? '' : current));
      setKind('note');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The note was not saved.')),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.contactNotes.forContact(contactId) }),
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
                </div>
                <p className="whitespace-pre-wrap break-words">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
