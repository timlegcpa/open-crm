import { useEffect, useState } from 'react';
import { Check, Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { ToneBadge } from '@/components/ui/tone-badge';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import { downloadBlob } from '@/lib/download';
import { isEdgeError } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';
import { fetchVerifiedTotp, generateBackupCodes, revokeBackupCodes } from './api';

/**
 * Two-factor sign-in with an authenticator app, and its backup codes. For the owner (in
 * Settings) and for a client (in the portal profile): it acts on whoever is signed in and
 * writes no audit row itself. The owner's host passes `onEvent` to record one; a client
 * session cannot write the owner's audit log.
 *
 * States: off, enrolling (QR code and code entry), showing the backup codes (once), on.
 * Backup codes come from the server (mfa-backup-codes), which keeps only their digests;
 * they are shown this once, and the "I saved these" box must be ticked to leave them.
 * Turning two-factor on survives a failed code generation: two-factor is on either way,
 * and "Make new backup codes" retries. Turning it off removes the authenticator first and
 * then revokes the codes; a revoke that fails is said out loud, never hidden.
 */

type State = 'loading' | 'off' | 'enrolling' | 'showing_codes' | 'on';

export type TwoFactorEvent =
  | { action: 'mfa_enabled'; details: Record<string, never> }
  | { action: 'mfa_disabled'; details: { backup_codes_revoked: boolean } };

function friendlyError(err: unknown, fallback: string): string {
  return isEdgeError(err) ? err.message : fallback;
}

export function TwoFactorSection({ onEvent }: { onEvent?: (event: TwoFactorEvent) => void }) {
  const { displayName } = usePublicBranding();
  const { copy, copiedKey } = useCopyToClipboard();
  const [state, setState] = useState<State>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchVerifiedTotp()
      .then((factor) => {
        if (cancelled) return;
        setFactorId(factor?.id ?? null);
        setState(factor ? 'on' : 'off');
      })
      .catch(() => {
        if (!cancelled) setState('off');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showCodes = (next: string[]) => {
    setCodes(next);
    setSaved(false);
    setState('showing_codes');
  };

  const enroll = async () => {
    setBusy(true);
    try {
      const auth = getSupabase().auth;
      // An abandoned enrolment leaves an unverified factor that would block a new one.
      const { data: listed } = await auth.mfa.listFactors();
      for (const stale of listed?.all?.filter((f) => f.status !== 'verified') ?? []) {
        await auth.mfa.unenroll({ factorId: stale.id });
      }
      const { data, error } = await auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: displayName ? `${displayName} sign-in` : 'Authenticator',
      });
      if (error) throw error;
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setOtp('');
      setState('enrolling');
    } catch {
      toast.error('Two-factor setup could not start. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!factorId || otp.length !== 6 || busy) return;
    setBusy(true);
    try {
      const auth = getSupabase().auth;
      const { data: challenge, error: challengeError } = await auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error } = await auth.mfa.verify({ factorId, challengeId: challenge.id, code: otp });
      if (error) {
        toast.error('That code did not work. Try the current one.');
        setOtp('');
        return;
      }
      onEvent?.({ action: 'mfa_enabled', details: {} });
      toast.success('Two-factor is on.');
      // The session is aal2 now. A failure here must not undo the enrolment.
      try {
        showCodes(await generateBackupCodes());
      } catch {
        setState('on');
        toast.error('Two-factor is on, but backup codes could not be made. Use "Make new backup codes" to try again.');
      }
    } catch {
      toast.error('Two-factor setup could not finish. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      showCodes(await generateBackupCodes());
    } catch (err) {
      toast.error(friendlyError(err, 'New backup codes could not be made. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!factorId) return;
    setBusy(true);
    try {
      const { error } = await getSupabase().auth.mfa.unenroll({ factorId });
      if (error) throw error;
      // Unenrolling ends the second factor either way, so a failed revoke is not an open
      // door, but the old codes are still stored and the person must be told.
      let revoked = true;
      try {
        await revokeBackupCodes();
      } catch {
        revoked = false;
      }
      onEvent?.({ action: 'mfa_disabled', details: { backup_codes_revoked: revoked } });
      setFactorId(null);
      setCodes([]);
      setState('off');
      if (revoked) toast.success('Two-factor is off.');
      else toast.error('Two-factor is off, but the old backup codes were not cleared. Turn two-factor on and make new codes to clear them.');
    } catch {
      toast.error('Two-factor could not be turned off. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const heading = displayName ? `${displayName} backup codes` : 'Backup codes';
    const text = `${heading}\n\n${codes.join('\n')}\n\nEach code works once. Keep them somewhere safe.\n`;
    downloadBlob(new Blob([text], { type: 'text/plain' }), 'backup-codes.txt');
  };

  const copyCodes = async () => {
    // Shown once: a copy the browser refused must never look like it worked.
    if (!(await copy(codes.join('\n'), 'codes'))) toast.error('Could not copy. Write the codes down or download them before you go on.');
  };

  return (
    <Panel
      title="Two-factor sign-in"
      action={state === 'on' ? <ToneBadge variant="success">On</ToneBadge> : undefined}
      bodyClassName="flex flex-col gap-4 p-4"
    >
      <p className="text-[13px] text-muted-foreground">
        Ask for a code from an authenticator app at every sign-in, on top of the password.
      </p>

      {state === 'loading' && <p className="text-[13px] text-muted-foreground">Loading...</p>}

      {state === 'off' && (
        <Button className="self-start" onClick={() => void enroll()} disabled={busy}>
          <ShieldCheck />
          Turn on two-factor
        </Button>
      )}

      {state === 'enrolling' && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <img src={qrCode} alt="QR code to scan with an authenticator app" className="h-44 w-44 shrink-0 rounded-md border border-border bg-white p-2" />
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-[13px]">Scan the code with your authenticator app, or enter this key by hand:</p>
            <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">{secret}</code>
            <div className="flex flex-col gap-2">
              <Label htmlFor="totp-code">Six-digit code from the app</Label>
              <InputOTP id="totp-code" maxLength={6} value={otp} onChange={setOtp} aria-label="Six-digit code from the app">
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void verify()} disabled={otp.length !== 6 || busy}>
                Verify and turn on
              </Button>
              <Button variant="ghost" onClick={() => setState('off')} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {state === 'showing_codes' && (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-warning bg-warning-light p-3 text-warning-dark">
            <p className="text-[13px] font-medium">Save your backup codes</p>
            <p className="mt-1 text-xs">
              If you lose your authenticator, one of these codes turns two-factor off so you can sign in. Each works once. They
              are shown only now.
            </p>
          </div>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Backup codes">
            {codes.map((code) => (
              <li key={code} className="rounded-md border border-border px-3 py-1.5 text-center font-mono text-[13px]">
                {code}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void copyCodes()}>
              {copiedKey === 'codes' ? <Check /> : <Copy />}
              {copiedKey === 'codes' ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="outline" size="sm" onClick={download}>
              <Download />
              Download
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="codes-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
            <Label htmlFor="codes-saved" className="text-[13px] font-normal">
              I have saved these codes
            </Label>
          </div>
          <Button className="self-start" disabled={!saved} onClick={() => setState('on')}>
            Done
          </Button>
        </div>
      )}

      {state === 'on' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void regenerate()}>
            Make new backup codes
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>
                <ShieldOff />
                Turn off two-factor
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Turn off two-factor?</AlertDialogTitle>
                <AlertDialogDescription>
                  Sign-in will need only the password, and your backup codes stop working. You can turn it on again at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void disable()}>Turn off</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </Panel>
  );
}
