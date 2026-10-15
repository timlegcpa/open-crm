import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { links } from '@/features/links';
import { SESSION_EXPIRED_KEY, useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** True when the portal signed this tab out for inactivity (the flag is read once, then removed). */
function readSessionExpired(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_EXPIRED_KEY) === '1';
  } catch {
    return false;
  }
}

export function SignInForm({ orgName }: { orgName: string | null }) {
  const { login } = useAuth();
  // Read during the first render, removed in the effect: the note shows once, for this
  // sign-in screen, and a later visit to it says nothing.
  const [expired] = useState(readSessionExpired);
  useEffect(() => {
    if (!expired) return;
    try {
      window.sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    } catch {
      // Nothing stored.
    }
  }, [expired]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      // One message for every rejection: which half was wrong is not the caller's to learn.
      if (result === 'rejected') setError('Email or password is incorrect.');
      if (result === 'unreachable') setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{orgName ?? 'Sign in'}</CardTitle>
        <CardDescription>Sign in to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {expired && (
            <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
              You were signed out after a period of inactivity. Sign in again to continue.
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !email || !password}>
            {busy ? 'Signing in...' : 'Sign in'}
          </Button>
          <Link to={links.forgotPassword()} className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline">
            Forgot password?
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}
