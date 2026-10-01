import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { getSupabase, supabaseConfigured } from '@/lib/supabase';
import { SignInForm } from '@/components/auth/SignInForm';
import { MfaChallenge } from '@/components/auth/MfaChallenge';
import { Button } from '@/components/ui/button';
import { queryClient } from '@/lib/queryClient';
import { OwnerApp } from '@/OwnerApp';

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

  // Nothing cached for one owner session may outlive it: clear on sign-out, on a
  // change of user, and whenever the database stops saying "owner".
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (ownerState !== 'owner') queryClient.clear();
  }, [ownerState, userId]);

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
              ? 'Could not confirm your account. Check that your Supabase project is reachable.'
              : 'This account is not the owner of this CRM.'}
          </p>
          <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
        </div>
      </Centered>
    );
  }

  // Signing out ends the owner state, and the effect above clears the cache.
  return <OwnerApp orgName={orgName} email={session.user.email ?? ''} onSignOut={() => void logout()} />;
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
