import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { CopyValue } from '@/components/ui/copy-value';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { ToneBadge } from '@/components/ui/tone-badge';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { isEdgeError } from '@/lib/edge';
import { formatDateTime } from '@/lib/format';
import { fetchLastDelivery, fetchLeadIntakeKey, leadIntakeUrl, revokeLeadIntakeKey, rotateLeadIntakeKey, settingsKeys } from './api';

/**
 * Lead intake: another system (a website form's server, a lead marketplace) posts leads in
 * with a key. The key is shown once, when it is made; only its last characters are kept
 * where the browser can read them. A replaced or removed key stops working within a minute.
 */

function sampleRequest(url: string): string {
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'x-api-key: YOUR_KEY' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"external_id":"form-1042","first_name":"Ada","last_name":"Lovelace","email":"ada@example.com","phone":"555-0100","business_name":"Acme LLC","notes":"Wants a call next week."}'`,
  ].join('\n');
}

export function LeadIntakeSection() {
  const queryClient = useQueryClient();
  const { copy, copiedKey } = useCopyToClipboard();
  const [shownKey, setShownKey] = useState<string | null>(null);
  const keyQuery = useQuery({ queryKey: settingsKeys.leadIntakeKey(), queryFn: fetchLeadIntakeKey });
  const lastQuery = useQuery({ queryKey: settingsKeys.lastDelivery(), queryFn: fetchLastDelivery });
  const url = leadIntakeUrl();
  const status = keyQuery.data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: settingsKeys.leadIntakeKey() });

  const rotate = useMutation({
    mutationFn: rotateLeadIntakeKey,
    onSuccess: (key) => setShownKey(key),
    onError: (err) => toast.error(isEdgeError(err) ? err.message : 'A key could not be made. Try again.'),
    onSettled: refresh,
  });

  const revoke = useMutation({
    mutationFn: revokeLeadIntakeKey,
    onSuccess: () => {
      setShownKey(null);
      toast.success('Key removed. It stops working within a minute.');
    },
    onError: (err) => toast.error(isEdgeError(err) ? err.message : 'The key was not removed. Try again.'),
    onSettled: refresh,
  });

  const busy = rotate.isPending || revoke.isPending;

  const copyKey = async () => {
    if (shownKey && !(await copy(shownKey, 'key'))) toast.error('Could not copy. Select the key and copy it by hand before you leave.');
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Lead intake"
        action={status ? <ToneBadge variant="success">On</ToneBadge> : <ToneBadge variant="neutral">Off</ToneBadge>}
        bodyClassName="flex flex-col gap-4 p-4"
      >
        <p className="text-[13px] text-muted-foreground">
          Let another system send leads straight in. Each lead becomes a contact in the first pipeline stage, or a note on the
          contact who already has that email address.
        </p>

        {keyQuery.isLoading && <p className="text-[13px] text-muted-foreground">Loading...</p>}
        {keyQuery.isError && <p className="text-[13px] text-destructive">The key status could not be loaded.</p>}

        {!keyQuery.isLoading && !keyQuery.isError && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Key</dt>
            <dd className="font-mono">{status ? `${status.key_hint}...` : 'None'}</dd>
            {status && (
              <>
                <dt className="text-muted-foreground">Made</dt>
                <dd>{formatDateTime(status.created_at)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Last lead</dt>
            <dd>{lastQuery.data ? formatDateTime(lastQuery.data) : 'None yet'}</dd>
          </dl>
        )}

        {shownKey && (
          <div className="flex flex-col gap-2 rounded-md border border-warning bg-warning-light p-3 text-warning-dark">
            <p className="text-[13px] font-medium">Copy this key now. It is not shown again.</p>
            <code className="break-all rounded-md bg-card px-2 py-1 font-mono text-xs text-foreground">{shownKey}</code>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyKey()}>
                {copiedKey === 'key' ? <Check /> : <Copy />}
                {copiedKey === 'key' ? 'Copied' : 'Copy key'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShownKey(null)}>
                I have saved it
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {status ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={busy}>
                  <KeyRound />
                  Replace key
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Replace the key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The old key stops working within a minute. Put the new key in the sending system straight away, or leads are
                    refused until you do.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void rotate.mutateAsync().catch(() => undefined)}>Replace</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button size="sm" disabled={busy || keyQuery.isLoading || keyQuery.isError} onClick={() => void rotate.mutateAsync().catch(() => undefined)}>
              <KeyRound />
              Make a key
            </Button>
          )}
          {status && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" disabled={busy}>
                  <Trash2 />
                  Remove key
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn off lead intake?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The key stops working within a minute and every lead sent after that is refused. Contacts already received stay.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void revoke.mutateAsync().catch(() => undefined)}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </Panel>

      <Panel title="How to send a lead" bodyClassName="flex flex-col gap-3 p-4 text-[13px]">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Address (POST, JSON)</span>
          {url ? <CopyValue value={url} label="lead intake address" className="font-mono text-xs" /> : <span>Not configured</span>}
        </div>
        <p>
          Send the key in an <code className="font-mono text-xs">x-api-key</code> header, or as{' '}
          <code className="font-mono text-xs">Authorization: Bearer YOUR_KEY</code>. Required fields:{' '}
          <code className="font-mono text-xs">external_id</code> (your own id for the lead, so a retry is never counted twice),{' '}
          <code className="font-mono text-xs">first_name</code> and <code className="font-mono text-xs">email</code>.
        </p>
        <p className="font-medium">Send from a server only. Never put this key in a web page, where anyone can read it.</p>
        {url && (
          <ScrollArea className="rounded-md border border-border bg-muted/40">
            <pre className="p-3 font-mono text-xs leading-5">{sampleRequest(url)}</pre>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </Panel>
    </div>
  );
}
