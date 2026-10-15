import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Send } from 'lucide-react';
import { Panel, TABLE_TH, TABLE_TR } from '@/components/layout/page';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isEdgeError } from '@/lib/edge';
import { getErrorMessage } from '@/lib/errors';
import { getFields, getPages, getSigners, sendEnvelope, type EnvelopeWithContact } from '../api';
import { SIGNER_ROLE_LABELS } from '../contract';
import { esignKeys } from '../keys';
import { readiness, sendProblems } from '../lib/sendReadiness';
import { resolveSignerName } from '../lib/signerName';

/** The last step: what goes out, to whom, and every reason it cannot go yet. */
export function ReviewSend({ envelope }: { envelope: EnvelopeWithContact }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pages = useQuery({ queryKey: esignKeys.pages(envelope.id), queryFn: () => getPages(envelope.id) });
  const signersQuery = useQuery({ queryKey: esignKeys.signers(envelope.id), queryFn: () => getSigners(envelope.id) });
  const fieldsQuery = useQuery({ queryKey: esignKeys.fields(envelope.id), queryFn: () => getFields(envelope.id) });

  const signers = useMemo(() => signersQuery.data ?? [], [signersQuery.data]);
  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  const pageCount = (pages.data ?? []).filter((p) => !p.deleted).length;
  const loaded = pages.isSuccess && signersQuery.isSuccess && fieldsQuery.isSuccess;

  const ready = readiness({ pages: pages.data ?? [], signers, fields, verificationLevel: envelope.verification_level });
  const problems = loaded ? sendProblems(ready, resolveSignerName) : [];
  const canSend = loaded && problems.length === 0;

  const counts = useMemo(() => {
    const map = new Map<string, { total: number; required: number }>();
    for (const f of fields) {
      const cur = map.get(f.signer_id) ?? { total: 0, required: 0 };
      cur.total += 1;
      if (f.required) cur.required += 1;
      map.set(f.signer_id, cur);
    }
    return map;
  }, [fields]);

  const send = useMutation({
    mutationFn: () => sendEnvelope(envelope.id),
    onSuccess: (data) => {
      if (data.failed_emails.length > 0) {
        toast.error(`Sent, but some invitations did not go out. Use Resend invite for: ${data.failed_emails.join(', ')}.`);
      } else {
        toast.success(`Sent to ${data.signers_invited} signer${data.signers_invited === 1 ? '' : 's'}.`);
      }
      setConfirmOpen(false);
      // The page shows the envelope's detail once its status is no longer draft.
      void queryClient.invalidateQueries({ queryKey: esignKeys.envelopes });
    },
    onError: (err) => {
      setConfirmOpen(false);
      if (isEdgeError(err) && err.code === 'send_validation') {
        toast.error(getErrorMessage(err, 'The envelope is not ready to send. Check the steps and try again.'));
        // Something changed elsewhere: reread so the list below shows it.
        void queryClient.invalidateQueries({ queryKey: esignKeys.envelope(envelope.id) });
        return;
      }
      if (isEdgeError(err) && err.code === 'sms_unavailable') {
        toast.error('Text messages are off, so a High verification envelope cannot be sent. Turn them on in settings, or use Standard.');
        return;
      }
      toast.error(getErrorMessage(err, 'The envelope was not sent. Try again.'));
    },
  });

  return (
    <Panel
      title="Review and send"
      action={
        <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!canSend || send.isPending}>
          {send.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          {send.isPending ? 'Sending...' : 'Send envelope'}
        </Button>
      }
      bodyClassName="flex flex-col gap-5 p-4"
    >
      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Title</dt>
          <dd className="truncate font-medium">{envelope.title}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Verification</dt>
          <dd className="font-medium">{envelope.verification_level === 'high' ? 'High (email and text code)' : 'Standard (email link)'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Pages</dt>
          <dd className="font-medium tabular-nums">{pageCount}</dd>
        </div>
      </dl>

      {!loaded && (signersQuery.isError || fieldsQuery.isError || pages.isError) && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the envelope: {getErrorMessage(signersQuery.error ?? fieldsQuery.error ?? pages.error)}
        </p>
      )}

      {signers.length > 0 && (
        <div className="rounded-md border border-border">
          <ScrollArea horizontal>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={`${TABLE_TH} w-14`}>Order</TableHead>
                  <TableHead className={TABLE_TH}>Name</TableHead>
                  <TableHead className={TABLE_TH}>Email</TableHead>
                  <TableHead className={TABLE_TH}>Role</TableHead>
                  <TableHead className={`${TABLE_TH} text-right`}>Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signers.map((s, idx) => (
                  <TableRow key={s.id} className={TABLE_TR}>
                    <TableCell className="text-[13px] tabular-nums">{idx + 1}</TableCell>
                    <TableCell className="text-[13px]">{resolveSignerName(s)}</TableCell>
                    <TableCell className="text-[13px]">{s.email}</TableCell>
                    <TableCell className="text-[13px]">{s.role ? SIGNER_ROLE_LABELS[s.role] : 'None'}</TableCell>
                    <TableCell className="text-right text-[13px] tabular-nums">{counts.get(s.id)?.total ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      )}

      {problems.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive bg-destructive-light p-4 text-sm text-destructive-dark">
          <p className="mb-1 font-medium">Not ready to send:</p>
          <ul className="list-disc space-y-1 pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !send.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this envelope?</AlertDialogTitle>
            <AlertDialogDescription>
              Each of the {signers.length} signer{signers.length === 1 ? '' : 's'} gets an email with a private signing link. After this,
              the documents and fields cannot be changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={send.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                send.mutate();
              }}
              disabled={send.isPending}
            >
              {send.isPending ? 'Sending...' : 'Send'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
