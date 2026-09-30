import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The second step for an account with an authenticator app: a six-digit code. */
export function MfaChallenge() {
  const { completeMfa, logout } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    // The busy guard matters: Enter in the input bypasses the disabled button.
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: factors, error: factorsErr } = await supabase.auth.mfa.listFactors();
      if (factorsErr) {
        setError('Could not start verification. Try again.');
        return;
      }
      // Only a verified factor can answer; an abandoned enrolment leaves an unverified one.
      const totp = factors?.totp?.find((f) => f.status === 'verified');
      if (!totp) {
        setError('No authenticator is set up on this account.');
        return;
      }
      const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
      if (challengeErr || !challenge) {
        setError('Could not start verification. Try again.');
        return;
      }
      const { error: verifyErr } = await supabase.auth.mfa.verify({ factorId: totp.id, challengeId: challenge.id, code });
      if (verifyErr) {
        setError('That code did not work. Try the current one.');
        setCode('');
        return;
      }
      await completeMfa();
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Authenticator code</CardTitle>
        <CardDescription>Enter the six-digit code from your authenticator app.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={verify} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="mfa-code">Code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Checking...' : 'Verify'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void logout()}>
            Sign out
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
