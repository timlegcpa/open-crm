import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PUBLIC_PATHS } from '@/features/links';
import { requestPasswordReset } from './authRest';

/**
 * Ask for a password-reset email. The answer is the same whether or not the address has an
 * account, so the page cannot be used to find out who has one.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError('Enter a full email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(address, `${window.location.origin}${PUBLIC_PATHS.resetPassword}`);
    setBusy(false);
    if (result.ok) {
      setSent(true);
    } else if (result.status === 429) {
      setError('Too many requests. Wait a few minutes and try again.');
    } else if (result.status === 0) {
      setError('Could not reach the server. Try again.');
    } else {
      // Anything else (an unknown address included) reads as sent: no account lookup.
      setSent(true);
    }
  };

  return (
    <PublicPage title="Reset your password">
      {sent ? (
        <div className="flex flex-col gap-3" role="status">
          <p className="text-[14px]">
            If an account uses that address, an email with a reset link is on its way. The link works once and expires soon.
          </p>
          <Link to="/" className="text-[14px] text-link underline-offset-2 hover:underline">
            Back to sign-in
          </Link>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          <p className="text-[14px] text-muted-foreground">Enter your email and we will send you a link to choose a new password.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="self-start" disabled={!email.trim() || busy}>
            {busy ? 'Sending...' : 'Send reset link'}
          </Button>
          <Link to="/" className="text-[13px] text-link underline-offset-2 hover:underline">
            Back to sign-in
          </Link>
        </form>
      )}
    </PublicPage>
  );
}
