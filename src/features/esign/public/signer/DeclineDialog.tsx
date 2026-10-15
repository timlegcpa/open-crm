import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { REASON_MAX } from '../../contract';

/** Decline, with an optional reason the sender sees. Cannot be undone: the request closes for everyone. */
export function DeclineDialog({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Decline to sign?</DialogTitle>
          <DialogDescription>
            The request closes for every signer and the sender is told. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(reason);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-decline-reason">Reason (optional)</Label>
            <Textarea
              id="esign-decline-reason"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby="esign-decline-count"
            />
            <p id="esign-decline-count" className="text-right text-xs tabular-nums text-muted-foreground">
              {reason.length}/{REASON_MAX}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Keep the request open
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Decline
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
