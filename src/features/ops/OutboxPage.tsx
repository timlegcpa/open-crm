import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Mail, MessageSquare, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, PAGE, PageHeader, Panel, Surface } from '@/components/layout/page';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { CopyValue } from '@/components/ui/copy-value';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clearOutbox, listOutbox, opsKeys, type OutboxRow } from './api';
import { Pager } from './Pager';

const LINK = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Plain text with its web links clickable (the walkthrough follows invite and sign-in links
 * from here). Only http and https become links; everything else stays text.
 */
export function linkify(text: string): ReactNode[] {
  return text.split(LINK).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer noopener" className="break-all text-link underline underline-offset-2">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * The email as the recipient would see it, inside a sandbox with no permissions at all: no
 * scripts, no same-origin access, no forms, no top navigation. The HTML came from a
 * template filled with contact data, so it is never rendered into this page itself.
 */
export function HtmlPreview({ html }: { html: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={html} className="h-[420px] w-full rounded-md border border-border bg-white" />;
}

function Message({ row }: { row: OutboxRow }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted-foreground">To</dt>
        <dd className="min-w-0"><CopyValue value={row.recipient} label="recipient" /></dd>
        <dt className="text-muted-foreground">From</dt>
        <dd>{row.sender ?? ''}</dd>
        {row.subject !== null && (
          <>
            <dt className="text-muted-foreground">Subject</dt>
            <dd>{row.subject}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Written</dt>
        <dd>{formatDateTime(row.created_at)}</dd>
      </dl>
      {row.body_text && <p className="whitespace-pre-wrap break-words text-[13px]">{linkify(row.body_text)}</p>}
      {row.body_html && <HtmlPreview html={row.body_html} />}
    </div>
  );
}

export function OutboxPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const outbox = useQuery({ queryKey: opsKeys.outbox(page), queryFn: () => listOutbox(page), refetchInterval: 15_000 });
  const clear = useMutation({ mutationFn: clearOutbox, onSettled: () => queryClient.invalidateQueries({ queryKey: ['ops', 'outbox'] }) });

  const rows = outbox.data?.rows ?? [];
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const onClear = async () => {
    setConfirm(false);
    try {
      const n = await clear.mutateAsync();
      setSelectedId(null);
      setPage(0);
      toast.success(`Cleared ${n} ${n === 1 ? 'message' : 'messages'}.`);
    } catch (err) {
      toast.error(`Could not clear the outbox: ${getErrorMessage(err)}`);
    }
  };

  return (
    <>
      <PageHeader
        title="Outbox"
        subtitle="Messages written here instead of being sent"
        actions={
          <Button size="sm" variant="outline" disabled={rows.length === 0 || clear.isPending} onClick={() => setConfirm(true)}>
            <Trash2 aria-hidden="true" />
            Clear
          </Button>
        }
      />
      <div className={`${PAGE} flex flex-col gap-3`}>
        <Alert>
          <AlertDescription>
            Messages land here only when no email or SMS provider is set and ENVIRONMENT is not production. They can
            hold working sign-in links and codes, so they are removed after seven days.
          </AlertDescription>
        </Alert>

        {outbox.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-sm font-medium">Could not load the outbox.</p>
            <p className="text-sm text-muted-foreground">{getErrorMessage(outbox.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void outbox.refetch()}>Try again</Button>
          </div>
        ) : outbox.isPending ? (
          <p className="text-sm text-muted-foreground">Loading messages...</p>
        ) : rows.length === 0 ? (
          <Surface>
            <EmptyState icon={<Inbox />} title="The outbox is empty" description="Invitations, codes and emails sent while no provider is set appear here." />
          </Surface>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <Panel title="Messages" bodyClassName="p-0">
              <ScrollArea className="h-[60vh]" fitWidth>
                <ul className="divide-y divide-border">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        aria-pressed={selected?.id === row.id}
                        onClick={() => setSelectedId(row.id)}
                        className={cn(
                          'flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-accent',
                          selected?.id === row.id && 'bg-accent',
                        )}
                      >
                        {row.channel === 'email' ? (
                          <Mail aria-label="Email" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <MessageSquare aria-label="Text message" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{row.subject ?? row.recipient}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.recipient} · {formatDateTime(row.created_at)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </Panel>
            <Panel title={selected?.channel === 'sms' ? 'Text message' : 'Email'} bodyClassName="p-0">
              <ScrollArea className="h-[60vh]" fitWidth>
                {selected && <Message row={selected} />}
              </ScrollArea>
            </Panel>
          </div>
        )}
        <Pager page={page} hasMore={outbox.data?.hasMore ?? false} onPage={setPage} label="Outbox" />
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the outbox?</AlertDialogTitle>
            <AlertDialogDescription>Every message here is deleted. Nothing is sent.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onClear()}>Clear</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
