import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, LogOut } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { getSupabase } from '@/lib/supabase';
import { changePassword, sendReauthenticationCode, verifyCurrentPassword } from '@/lib/passwordChange';
import { MAX_PASSWORD_BYTES, passwordProblem, PASSWORD_RULES_TEXT } from '@/lib/passwordRules';
import { emailDomain, recordAudit } from './api';
import { TwoFactorSection, type TwoFactorEvent } from './TwoFactorSection';

/** The owner's own sign-in: password, sign-in email, two-factor, and every open session. */
export function SecuritySection() {
  const onTwoFactorEvent = (event: TwoFactorEvent) => void recordAudit(event.action, event.details);
  return (
    <div className="flex flex-col gap-4">
      <PasswordPanel />
      <EmailPanel />
      <TwoFactorSection onEvent={onTwoFactorEvent} />
      <SessionsPanel />
    </div>
  );
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          maxLength={MAX_PASSWORD_BYTES}
          className="pr-10"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setShown((s) => !s)}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The current password is checked on a throwaway client (verifyCurrentPassword), never on
 * the app's own: that would swap the two-factor session for a password-only one. That check
 * lives in the browser, so it is the fast path and the five-try lockout, not the guard: with
 * secure password change on, Auth itself refuses a session without a recent sign-in, and
 * the change then waits for the one-time code Auth emails (sent as the update's nonce).
 * After the change every other session is signed out, so a device the owner is changing it
 * because of is shut out at once.
 */
function PasswordPanel() {
  const { session } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), lockedUntil - now);
    return () => clearTimeout(timer);
  }, [lockedUntil, now]);

  // Set when Auth asked for a recent sign-in: the change waits for the emailed code.
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');

  const locked = lockedUntil > now;
  const problem = next ? passwordProblem(next) : null;
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = Boolean(current) && Boolean(next) && !problem && confirm === next && !busy && !locked;

  const finish = async () => {
    const { error: signOutError } = await getSupabase().auth.signOut({ scope: 'others' });
    setFailures(0);
    void recordAudit('password_change', { other_sessions_revoked: !signOutError });
    setCurrent('');
    setNext('');
    setConfirm('');
    setCode('');
    setAwaitingCode(false);
    if (signOutError) toast.error('Password changed, but other sessions are still signed in. Use "Sign out everywhere" below.');
    else toast.success('Password changed. Every other session is signed out.');
  };

  const askForCode = async () => {
    await sendReauthenticationCode();
    setCode('');
    setAwaitingCode(true);
    toast.success('We emailed you a code. Enter it to finish the change.');
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    const nonce = code.trim();
    if (!nonce || busy || !next || problem || confirm !== next) return;
    setBusy(true);
    try {
      const result = await changePassword(next, nonce);
      if (result === 'ok') await finish();
      else if (result === 'code_not_valid') toast.error('That code is not right or has expired. Check it, or send a new one.');
      else await askForCode();
    } catch {
      toast.error('The password was not changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    try {
      await askForCode();
    } catch {
      toast.error('A code could not be sent. Try again in a minute.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (awaitingCode) return submitCode(event);
    const email = session?.user?.email;
    if (!ready || !email) return;
    setBusy(true);
    try {
      if (!(await verifyCurrentPassword(email, current))) {
        const count = failures + 1;
        if (count >= MAX_FAILURES) {
          setFailures(0);
          const until = Date.now() + LOCKOUT_MS;
          setNow(Date.now());
          setLockedUntil(until);
          toast.error('Too many wrong passwords. Wait 30 seconds and try again.');
        } else {
          setFailures(count);
          toast.error('The current password is not right.');
        }
        return;
      }
      if (next === current) {
        toast.error('Choose a password different from the current one.');
        return;
      }
      // The server decides: without a recent sign-in it asks for the emailed code first.
      if ((await changePassword(next)) === 'ok') await finish();
      else await askForCode();
    } catch {
      toast.error('The password was not changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Password" bodyClassName="p-4">
      <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-4" noValidate>
        <PasswordField id="password-current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
        <PasswordField id="password-new" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
        <p className={problem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{problem ?? PASSWORD_RULES_TEXT}</p>
        <PasswordField id="password-confirm" label="New password again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {mismatch && <p className="text-xs text-destructive">The two new passwords do not match.</p>}
        {locked && <p className="text-xs text-destructive">Too many wrong passwords. Wait 30 seconds.</p>}
        {awaitingCode ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-code">Code from the email</Label>
              <Input
                id="password-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                For your safety, changing the password needs a code sent to {session?.user?.email ?? 'your sign-in email'}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!code.trim() || busy}>
                Confirm and change password
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void resend()}>
                Send a new code
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAwaitingCode(false);
                  setCode('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="submit" className="self-start" disabled={!ready}>
            Change password
          </Button>
        )}
      </form>
    </Panel>
  );
}

/**
 * Changing the sign-in email sends a confirmation link to the old address and the new
 * one; the change takes effect only when both are followed.
 */
function EmailPanel() {
  const { session } = useAuth();
  const currentEmail = session?.user?.email ?? '';
  const pending = session?.user?.new_email ?? null;
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = email.trim();
    if (!next || busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      toast.error('Enter a full email address.');
      return;
    }
    if (next.toLowerCase() === currentEmail.toLowerCase()) {
      toast.error('That is already your sign-in email.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await getSupabase().auth.updateUser(
        { email: next },
        { emailRedirectTo: `${window.location.origin}/settings/security` },
      );
      if (error) throw error;
      const domain = emailDomain(next);
      void recordAudit('email_change_requested', domain ? { new_email_domain: domain } : {});
      setEmail('');
      toast.success('Check both inboxes. The change takes effect once both links are followed.');
    } catch {
      toast.error('The change could not be started. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Sign-in email" bodyClassName="p-4">
      <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-4" noValidate>
        <p className="text-[13px]">
          You sign in as <span className="font-medium">{currentEmail || 'unknown'}</span>.
          {pending && <> A change to <span className="font-medium">{pending}</span> is waiting for confirmation.</>}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email-new">New sign-in email</Label>
          <Input id="email-new" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
          <p className="text-xs text-muted-foreground">A link goes to both the current address and the new one. Follow both to finish.</p>
        </div>
        <Button type="submit" variant="outline" className="self-start" disabled={!email.trim() || busy}>
          Change email
        </Button>
      </form>
    </Panel>
  );
}

/**
 * The browser's name from its user agent. Order matters: every Chromium browser says
 * "Chrome" and Safari's sibling engines say "Safari", so the specific names come first.
 */
export function browserName(ua: string): string {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/') || ua.includes('CriOS/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  return 'This browser';
}

function SessionsPanel() {
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  const signedIn = session?.user?.last_sign_in_at;

  const signOutEverywhere = async () => {
    setBusy(true);
    try {
      // Written first: the session that could write it is about to end.
      await recordAudit('sign_out_all_devices');
      const { error } = await getSupabase().auth.signOut({ scope: 'global' });
      if (error) throw error;
    } catch {
      toast.error('Sign-out did not finish. Try again.');
      setBusy(false);
    }
  };

  return (
    <Panel title="Sessions" bodyClassName="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-0.5 rounded-md border border-border p-3">
        <p className="text-[13px] font-medium">This session</p>
        <p className="text-xs text-muted-foreground">
          {browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent)}
          {signedIn ? `, signed in ${formatDateTime(signedIn)}` : ''}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" className="self-start" disabled={busy}>
            <LogOut />
            Sign out everywhere
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>Every session ends, this one included. You will need to sign in again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOutEverywhere()}>Sign out everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
