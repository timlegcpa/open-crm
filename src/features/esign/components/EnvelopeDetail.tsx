import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Ban, Download, FileCheck2, Loader2, Mail, Trash2 } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { StatusBadge } from '@/components/contacts/StatusBadge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { queryKeys } from '@/api/queryKeys';
import { useByKey, useContactStatuses } from '@/hooks/usePickLists';
import { getErrorMessage } from '@/lib/errors';
import { formatDate, formatDateTime, NO_VALUE_TEXT } from '@/lib/format';
import { downloadAudit, downloadSignedCopy, getSigners, moveContactToNew, type EnvelopeWithContact, type SignerWithContact } from '../api';
import { LIVE_ENVELOPE_STATUSES, RESENDABLE_SIGNER_STATUSES, SIGNER_ROLE_LABELS } from '../contract';
import { esignKeys } from '../keys';
import { resolveSignerName } from '../lib/signerName';
import { DeleteEnvelopeDialog, ResendInviteDialog, VoidEnvelopeDialog } from './EnvelopeDialogs';
import { DocumentList } from './DocumentsStep';
import { EventLogTable } from './EventLogTable';
import { EsignStatusBadge } from './StatusBadge';

function progressLine(s: SignerWithContact): string | null {
  if (s.signed_at) return `Signed ${formatDateTime(s.signed_at)}`;
  if (s.first_viewed_at) return `Viewed the document ${formatDateTime(s.first_viewed_at)}`;
  if (s.opened_email_at) return `Opened the link ${formatDateTime(s.opened_email_at)}`;
  if (s.invited_at) return `Invited ${formatDateTime(s.invited_at)}, not opened yet`;
  return null;
}

/** An envelope that has left draft: who has signed, what can be done, and the event log. */
export function EnvelopeDetail({ envelope }: { envelope: EnvelopeWithContact }) {
  const queryClient = useQueryClient();
  const [voidOpen, setVoidOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resendTarget, setResendTarget] = useState<SignerWithContact | null>(null);
  const [busy, setBusy] = useState<'audit' | 'signed' | null>(null);
  const isLive = LIVE_ENVELOPE_STATUSES.includes(envelope.status);

  // While out for signature, keep "who has not signed" current without a reload.
  const signers = useQuery({
    queryKey: esignKeys.signers(envelope.id),
    queryFn: () => getSigners(envelope.id),
    refetchInterval: isLive ? 30_000 : false,
    refetchOnWindowFocus: isLive,
  });
  const statuses = useContactStatuses();
  const statusByKey = useByKey(statuses.data);

  const moveToNew = useMutation({
    mutationFn: (contactId: string) => moveContactToNew(contactId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.signers(envelope.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('The contact is now a new lead.');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The contact was not moved. Try again.')),
  });

  const run = async (which: 'audit' | 'signed') => {
    setBusy(which);
    try {
      if (which === 'audit') await downloadAudit(envelope);
      else await downloadSignedCopy(envelope);
    } catch (err) {
      toast.error(getErrorMessage(err, 'The download failed. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel title="Summary" bodyClassName="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <EsignStatusBadge status={envelope.status} />
              <span className="text-xs text-muted-foreground">
                {envelope.verification_level === 'high' ? 'High verification' : 'Standard verification'}
              </span>
            </div>
            <h2 className="break-words text-[15px] font-semibold">{envelope.title}</h2>
            {envelope.void_reason && <p className="text-sm text-muted-foreground">Void reason: {envelope.void_reason}</p>}
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Sent</dt>
            <dd className="tabular-nums">{envelope.sent_at ? formatDate(envelope.sent_at) : NO_VALUE_TEXT}</dd>
            <dt className="text-muted-foreground">Completed</dt>
            <dd className="tabular-nums">{envelope.completed_at ? formatDate(envelope.completed_at) : NO_VALUE_TEXT}</dd>
            <dt className="text-muted-foreground">Voided</dt>
            <dd className="tabular-nums">{envelope.voided_at ? formatDate(envelope.voided_at) : NO_VALUE_TEXT}</dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd className="tabular-nums">{envelope.expires_at ? formatDate(envelope.expires_at) : NO_VALUE_TEXT}</dd>
          </dl>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Signers" className="lg:col-span-2" bodyClassName="p-0">
          {signers.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">Loading signers...</p>
          ) : signers.isError ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              Could not load the signers: {getErrorMessage(signers.error)}
            </p>
          ) : signers.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No signers on this envelope.</p>
          ) : (
            <ul className="divide-y divide-border">
              {signers.data.map((s) => {
                const stage = s.contact?.status ?? null;
                const contactId = s.contact?.id ?? null;
                const moving = moveToNew.isPending && moveToNew.variables === contactId;
                const line = progressLine(s);
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{resolveSignerName(s)}</span>
                        <EsignStatusBadge status={s.status} />
                        {s.role && <span className="text-xs text-muted-foreground">{SIGNER_ROLE_LABELS[s.role]}</span>}
                        {stage && <StatusBadge statusKey={stage} status={statusByKey.get(stage)} />}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{s.email}</div>
                      {line && <div className="mt-0.5 text-xs text-muted-foreground">{line}</div>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {stage === 'esign_signer' && contactId && (
                        <Button variant="outline" size="sm" onClick={() => moveToNew.mutate(contactId)} disabled={moving}>
                          {moving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
                          Move to New
                        </Button>
                      )}
                      {isLive && RESENDABLE_SIGNER_STATUSES.includes(s.status) && (
                        <Button variant="outline" size="sm" onClick={() => setResendTarget(s)}>
                          <Mail aria-hidden="true" />
                          Resend invite
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Actions" bodyClassName="flex flex-col gap-2 p-3">
          <Button variant="outline" className="w-full justify-start" onClick={() => void run('audit')} disabled={busy !== null}>
            {busy === 'audit' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            Download audit trail
          </Button>
          {isLive && (
            <Button
              variant="outline"
              className="w-full justify-start border-destructive text-destructive-dark hover:bg-destructive-light hover:text-destructive-dark"
              onClick={() => setVoidOpen(true)}
            >
              <Ban aria-hidden="true" />
              Void envelope
            </Button>
          )}
          <Button
            variant="outline"
            className="w-full justify-start border-destructive text-destructive-dark hover:bg-destructive-light hover:text-destructive-dark"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 aria-hidden="true" />
            Delete envelope
          </Button>
        </Panel>
      </div>

      {envelope.status === 'completed' && (
        <Panel title="Signed document" bodyClassName="p-4">
          <div className="flex items-start gap-3">
            <FileCheck2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
            <div className="flex-1 text-sm">
              <p>
                Every signer has signed{envelope.completed_at ? ` (${formatDate(envelope.completed_at)})` : ''}. The signed copy carries each
                signature and the audit trail, and each signer was emailed it.
              </p>
              <Button className="mt-3" size="sm" onClick={() => void run('signed')} disabled={!envelope.signed_pdf_path || busy !== null}>
                {busy === 'signed' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                Download signed copy
              </Button>
              {!envelope.signed_pdf_path && <p className="mt-2 text-xs text-muted-foreground">The signed copy is still being prepared.</p>}
            </div>
          </div>
        </Panel>
      )}

      <Panel title="Documents" bodyClassName="p-3">
        <DocumentList envelopeId={envelope.id} canDelete={false} />
      </Panel>

      <Panel title="Event log" bodyClassName="p-3">
        <EventLogTable envelopeId={envelope.id} live={isLive} />
      </Panel>

      <VoidEnvelopeDialog envelopeId={envelope.id} open={voidOpen} onOpenChange={setVoidOpen} />
      <DeleteEnvelopeDialog
        envelopeId={envelope.id}
        envelopeTitle={envelope.title}
        envelopeStatus={envelope.status}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      {resendTarget && (
        <ResendInviteDialog
          envelopeId={envelope.id}
          signerId={resendTarget.id}
          signerEmail={resendTarget.email}
          open
          onOpenChange={(next) => !next && setResendTarget(null)}
        />
      )}
    </div>
  );
}
