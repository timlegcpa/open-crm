import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isEdgeError } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';
import { redeemBackupCode } from './api';

/**
 * "Use a backup code" on the two-factor challenge, for the owner and for a client. The
 * person is signed in with a password but not yet with the second factor. A good code
 * turns two-factor off and the server signs out every session, so this one is closed here
 * too (when the person moves on) and the server's note says what happened and what to do next (sign in again, then
 * turn two-factor back on). An email about the change goes to the account and the owner.
 *
 * Rendered by the two-factor challenge screen (src/components/auth/MfaChallenge.tsx);
 * `onCancel` goes back to entering an authenticator code.
 */
export function BackupCodeRecovery({ onCancel }: { onCancel?: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      // The server has already ended every session. This browser's copy is cleared only
      // when the person moves on: signing out here would swap this screen for the sign-in
      // form before the note could be read.
      setNote(await redeemBackupCode(code.trim()));
    } catch (err) {
      toast.error(isEdgeError(err) ? err.message : 'The code could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (note) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <p className="text-[14px] font-medium">Two-factor is off</p>
        <p className="text-[13px] text-muted-foreground">{note}</p>
        <Button className="self-start" onClick={() => void getSupabase().auth.signOut({ scope: 'local' }).catch(() => undefined)}>
          Sign in again
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backup-code">Backup code</Label>
        <Input
          id="backup-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          One of the codes saved when two-factor was turned on. Using it turns two-factor off and signs you out everywhere.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={!code.trim() || busy}>
          Use backup code
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Use the authenticator instead
          </Button>
        )}
      </div>
    </form>
  );
}
