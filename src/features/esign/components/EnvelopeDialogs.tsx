import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { deleteEnvelope, isRequiresForce, resendInvite, voidEnvelope } from '../api';
import { REASON_MAX } from '../contract';
import { esignKeys } from '../keys';

const CONFIRM_WORD = 'DELETE';

/**
 * Delete an envelope, after typing DELETE. A completed envelope is deleted with `force`:
 * the server keeps its hash and audit trail in a tombstone first, so the verify page still
 * recognises the signed copy. Should the status have changed under the dialog, the server
 * answers `requires_force` and nothing is removed; the dialog then says so.
 */
export function DeleteEnvelopeDialog({
  envelopeId,
  envelopeTitle,
  envelopeStatus,
  open,
  onOpenChange,
}: {
  envelopeId: string;
  envelopeTitle: string;
  envelopeStatus: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isCompleted = envelopeStatus === 'completed';

  const mutation = useMutation({
    mutationFn: () => deleteEnvelope(envelopeId, isCompleted),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.envelopes });
      toast.success(`"${envelopeTitle}" was deleted.`);
      setConfirmText('');
      onOpenChange(false);
      navigate(links.esign());
    },
    onError: (err) => {
      toast.error(
        isRequiresForce(err)
          ? 'This envelope was completed in the meantime, so nothing was deleted. Reload and try again.'
          : getErrorMessage(err, 'The envelope was not deleted. Try again.'),
      );
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (mutation.isPending) return;
    if (!next) setConfirmText('');
    onOpenChange(next);
  };

  const canConfirm = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this envelope?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes &quot;{envelopeTitle}&quot;, its working PDFs, its event log and every signer and field
            record. A signed copy stays in the contact&apos;s documents; delete it there if you want it gone. This cannot be
            undone.
            {isCompleted &&
              ' Because this envelope is completed, its fingerprint and audit trail are kept first, so the verify page still recognises the signed copy.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="esign-delete-confirm">
            Type <span className="font-mono">{CONFIRM_WORD}</span> to confirm
          </Label>
          <Input
            id="esign-delete-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_WORD}
            disabled={mutation.isPending}
            autoComplete="off"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Keep envelope</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (canConfirm) mutation.mutate();
            }}
            disabled={!canConfirm || mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Void an envelope that is out for signature, with an optional reason for the event log. */
export function VoidEnvelopeDialog({
  envelopeId,
  open,
  onOpenChange,
}: {
  envelopeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => voidEnvelope(envelopeId, reason.trim() || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.envelopes });
      toast.success('The envelope was voided.');
      setReason('');
      onOpenChange(false);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The envelope was not voided. Try again.')),
  });

  const handleOpenChange = (next: boolean) => {
    if (mutation.isPending) return;
    if (!next) setReason('');
    onOpenChange(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this envelope?</AlertDialogTitle>
          <AlertDialogDescription>
            Every open signing link stops working, and anyone who has not signed is told the request was cancelled. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="esign-void-reason">Reason (optional)</Label>
          <Textarea
            id="esign-void-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
            placeholder="A short note for the event log"
            rows={3}
            disabled={mutation.isPending}
          />
          <p className="text-right text-xs tabular-nums text-muted-foreground">
            {reason.length}/{REASON_MAX}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Keep envelope</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
            disabled={mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Void envelope
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Send a signer a fresh link; the old one stops working at once. */
export function ResendInviteDialog({
  envelopeId,
  signerId,
  signerEmail,
  open,
  onOpenChange,
}: {
  envelopeId: string;
  signerId: string;
  signerEmail: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => resendInvite(envelopeId, signerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.signers(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.events(envelopeId) });
      void queryClient.invalidateQueries({ queryKey: esignKeys.envelope(envelopeId) });
      toast.success(`A new link was sent to ${signerEmail}.`);
      onOpenChange(false);
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The invite was not sent. Try again.')),
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resend the invite?</AlertDialogTitle>
          <AlertDialogDescription>
            A new signing link goes to <span className="font-medium text-foreground">{signerEmail}</span>. The previous link
            stops working at once.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Resend invite
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
