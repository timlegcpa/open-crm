import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';

/**
 * The recovery key, shown exactly once. It cannot be dismissed (no outside click, no
 * Escape, no close) until the owner says it is saved.
 */
export function RecoveryKeyDialog({ recoveryKey, onClose }: { recoveryKey: string; onClose: () => void }) {
  const { copy, copiedKey } = useCopyToClipboard(3000);
  const [copyFailed, setCopyFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  // This is the only copy. A failed copy that said nothing would let the owner tick "saved"
  // and lose it, so the result is shown either way.
  const handleCopy = async () => setCopyFailed(!(await copy(recoveryKey, 'recovery')));

  return (
    <Dialog open onOpenChange={(open) => { if (!open && saved) onClose(); }}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (!saved) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-caution" aria-hidden="true" />
            Save your recovery key
          </DialogTitle>
          <DialogDescription>
            If you forget your encryption password, this key is the only way to read your messages again. It is shown
            only once. Keep it somewhere safe, away from this computer.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-32 rounded-lg border bg-muted">
          <p className="select-all break-all p-3 font-mono text-xs leading-relaxed" aria-label="Recovery key">
            {recoveryKey}
          </p>
        </ScrollArea>

        <Button variant="outline" onClick={() => void handleCopy()}>
          {copiedKey === 'recovery' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copiedKey === 'recovery' ? 'Copied' : 'Copy recovery key'}
        </Button>
        {copyFailed && (
          <p role="alert" className="text-sm text-destructive">
            The key could not be copied. Select it above and copy it by hand before you go on.
          </p>
        )}

        <div className="flex items-start gap-2">
          <Checkbox id="recovery-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} className="mt-0.5" />
          <Label htmlFor="recovery-saved" className="font-normal leading-snug text-muted-foreground">
            I have saved this recovery key somewhere safe
          </Label>
        </div>

        <Button onClick={onClose} disabled={!saved}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
