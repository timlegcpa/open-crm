import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { getSupabase, supabaseConfigured } from '@/lib/supabase';
import { SignInForm } from '@/components/auth/SignInForm';
import { MfaChallenge } from '@/components/auth/MfaChallenge';
import { Button } from '@/components/ui/button';

function Centered({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center p-4">{children}</main>;
}

/** The organization's display name, readable before sign-in. Null until known. */
function useOrgName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSupabase()
      .rpc('get_org_branding')
      .then(
        ({ data }) => {
          const value = (data as { display_name?: unknown } | null)?.display_name;
          if (!cancelled && typeof value === 'string') setName(value);
        },
        () => {
          // The name is decoration; the sign-in form works without it.
        },
      );
    return () => { cancelled = true; };
  }, []);
  return name;
}

function Gate() {
  const { session, isLoadingAuth, mfaGate, ownerState, logout } = useAuth();
  const orgName = useOrgName();

  if (isLoadingAuth) return <Centered><p className="text-muted-foreground">Loading...</p></Centered>;
  if (!session) return <Centered><SignInForm orgName={orgName} /></Centered>;
  // Fail closed: nothing protected renders until both checks have an answer.
  if (mfaGate === 'checking') return <Centered><p className="text-muted-foreground">Checking your session...</p></Centered>;
  if (mfaGate === 'required') return <Centered><MfaChallenge /></Centered>;
  if (ownerState === 'checking') return <Centered><p className="text-muted-foreground">Checking your account...</p></Centered>;

  if (ownerState !== 'owner') {
    return (
      <Centered>
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <p>
            {ownerState === 'error'
              ? 'Could not confirm your account. Check that the local stack is running.'
              : 'This account is not the owner of this CRM.'}
          </p>
          <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold">{orgName ?? 'Open CRM'}</h1>
        <p className="text-muted-foreground">Signed in as {session.user.email}.</p>
        <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
      </div>
    </Centered>
  );
}

export function App() {
  if (!supabaseConfigured) {
    return (
      <Centered>
        <p className="max-w-md text-center text-muted-foreground">
          This clone is not connected to a Supabase project yet. Follow &ldquo;Running it&rdquo; in the
          README (it ends with <code>npm run dev:bootstrap</code>), then restart <code>npm run dev</code>.
        </p>
      </Centered>
    );
  }
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
