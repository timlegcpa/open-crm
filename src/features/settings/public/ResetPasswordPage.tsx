import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PUBLIC_PATHS } from '@/features/links';
import { MAX_PASSWORD_BYTES, passwordProblem, PASSWORD_RULES_TEXT } from '@/lib/passwordRules';
import { readRecoveryHash, resetErrorMessage, setPasswordWithToken, signOutEverywhere } from './authRest';

/**
 * Where the reset email lands: `/reset-password#access_token=...&type=recovery`. The token
 * is read once and the fragment is cleared at once, so it is not left in the address bar
 * or the history. After the change every session of the account is ended, the recovery
 * one included, and the person signs in with the new password. When that sign-out fails
 * the page says so and keeps the token to try it again: it never reports devices as
 * signed out when they may not be.
 */

type Phase = 'form' | 'invalid' | 'signout_failed' | 'done';

export function ResetPasswordPage() {
  // Read during the first render, not in the effect: StrictMode runs a mount effect twice,
  // and the second run would find the fragment already cleared.
  const [token, setToken] = useState<string | null>(() => readRecoveryHash(window.location.hash).token);
  const [phase, setPhase] = useState<Phase>(() => (token ? 'form' : 'invalid'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const problem = password ? passwordProblem(password) : null;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = Boolean(password) && !problem && confirm === password && !busy;

  /** The password is already changed; this only ends the other sessions. */
  const endSessions = async (recoveryToken: string) => {
    const result = await signOutEverywhere(recoveryToken);
    if (result.ok) {
      setToken(null);
      setError(null);
      setPhase('done');
    } else {
      setError(
        result.status === 401 || result.status === 403
          ? 'This link has expired, so other devices could not be signed out from here. Sign in with the new password and use "Sign out everywhere".'
          : 'Other signed-in devices could not be signed out. Try again.',
      );
      setPhase('signout_failed');
    }
  };

  const retrySignOut = async () => {
    if (!token || busy) return;
    setBusy(true);
    await endSessions(token);
    setBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !token) return;
    setBusy(true);
    setError(null);
    const result = await setPasswordWithToken(token, password);
    if (result.ok) {
      await endSessions(token);
    } else {
      setError(resetErrorMessage(result.status, result.code));
      // An expired link cannot be retried; a two-factor refusal keeps its own message.
      if ((result.status === 401 || result.status === 403) && result.code !== 'insufficient_aal') setPhase('invalid');
    }
    setBusy(false);
  };

  return (
    <PublicPage title="Choose a new password">
      {phase === 'invalid' && (
        <div className="flex flex-col gap-3" role="alert">
          <p className="text-[14px]">{error ?? 'This reset link is not valid or has expired.'}</p>
          <Link to={PUBLIC_PATHS.forgotPassword} className="text-[14px] text-link underline-offset-2 hover:underline">
            Ask for a new link
          </Link>
        </div>
      )}

      {phase === 'signout_failed' && (
        <div className="flex flex-col gap-3" role="alert">
          <p className="text-[14px]">Your password is changed.</p>
          <p className="text-[14px] text-destructive">{error}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void retrySignOut()} disabled={busy}>
              {busy ? 'Signing out...' : 'Sign out other devices'}
            </Button>
            <Link to="/" className="text-[14px] text-link underline-offset-2 hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-3" role="status">
          <p className="text-[14px]">Your password is changed, and every signed-in device is signed out.</p>
          <Link to="/" className="text-[14px] text-link underline-offset-2 hover:underline">
            Sign in
          </Link>
        </div>
      )}

      {phase === 'form' && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={MAX_PASSWORD_BYTES}
            />
            <p className={problem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{problem ?? PASSWORD_RULES_TEXT}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-confirm">New password again</Label>
            <Input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              maxLength={MAX_PASSWORD_BYTES}
            />
            {mismatch && <p className="text-xs text-destructive">The two passwords do not match.</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="self-start" disabled={!ready}>
            {busy ? 'Saving...' : 'Save new password'}
          </Button>
        </form>
      )}
    </PublicPage>
  );
}
