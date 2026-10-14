import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';

/**
 * Whether the session still owes a second factor.
 * 'checking'  — not resolved yet; render nothing protected (fail closed)
 * 'required'  — the user holds a verified factor but the session is still aal1
 * 'satisfied' — no verified factor, or already aal2
 */
export type MfaGate = 'checking' | 'required' | 'satisfied';

/**
 * Who the signed-in account is, as the DATABASE decides it (never a claim in the token):
 * 'owner'  — is_owner() is true: the owner app
 * 'client' — get_client_contact_id() names a contact (an active portal account): the portal
 * 'none'   — signed in, but neither: no access
 * 'error'  — the check could not be answered: fail closed, no access
 * 'checking' — not answered yet: render nothing protected
 */
export type Principal = 'checking' | 'owner' | 'client' | 'none' | 'error';

/** 'unreachable' means the Auth server never answered, not that the password was wrong. */
export type LoginResult = 'ok' | 'rejected' | 'unreachable';

interface AuthContextType {
  session: Session | null;
  isLoadingAuth: boolean;
  mfaGate: MfaGate;
  principal: Principal;
  /** The contact the signed-in client is, when `principal` is 'client'; otherwise null. */
  clientContactId: string | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Enrolment is read off the session first, and a user with no verified factor
 * short-circuits to 'satisfied' before anything can throw; only a holder of a
 * factor, who can answer a challenge, gets the fail-closed 'required'.
 */
async function evaluateMfaGate(session: Session | null): Promise<MfaGate> {
  if (!session) return 'satisfied';
  const verified = (session.user?.factors ?? []).filter((f) => f.status === 'verified');
  if (verified.length === 0) return 'satisfied';
  try {
    const { data, error } = await getSupabase().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return 'required';
    return data.currentLevel === 'aal2' ? 'satisfied' : 'required';
  } catch {
    return 'required';
  }
}

interface PrincipalResult {
  principal: Exclude<Principal, 'checking'>;
  clientContactId: string | null;
}

/**
 * The owner check first; only an account that is not the owner is asked whether it is a
 * client, so an owner session never calls the client RPC. Any failure is 'error'.
 */
async function resolvePrincipal(): Promise<PrincipalResult> {
  try {
    const owner = await getSupabase().rpc('is_owner');
    if (owner.error) return { principal: 'error', clientContactId: null };
    if (owner.data === true) return { principal: 'owner', clientContactId: null };
    const client = await getSupabase().rpc('get_client_contact_id');
    if (client.error) return { principal: 'error', clientContactId: null };
    return typeof client.data === 'string' && client.data !== ''
      ? { principal: 'client', clientContactId: client.data }
      : { principal: 'none', clientContactId: null };
  } catch {
    return { principal: 'error', clientContactId: null };
  }
}

/**
 * Never throws and never blocks: a broken audit write must not lock the owner out
 * or strand them signed in. A failure is logged to the console so it is visible.
 * Owner sessions only: the audit table accepts rows from the owner alone.
 */
async function recordAudit(userId: string, action: 'owner_login' | 'owner_logout'): Promise<void> {
  try {
    const { error } = await getSupabase().from('audit_logs').insert({
      user_id: userId,
      action,
      user_agent: navigator.userAgent.slice(0, 500),
    });
    if (error) console.warn(`Audit row ${action} was not written: ${error.message}`);
  } catch (err) {
    console.warn(`Audit row ${action} was not written`, err);
  }
}

const UNRESOLVED_GATE = { userId: null, gate: 'checking' } as const;
const UNRESOLVED_PRINCIPAL = { userId: null, principal: 'checking', clientContactId: null } as const;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  // Each result is stored WITH the user it was computed for, and read back only
  // when that user is still the current one, so a session change re-gates on the
  // same render that exposes it instead of one frame later. Both are cleared on
  // sign-out, so signing back in as the same user never reuses an old answer.
  const [mfaEval, setMfaEval] = useState<{ userId: string | null; gate: MfaGate }>(UNRESOLVED_GATE);
  const [principalEval, setPrincipalEval] = useState<{
    userId: string | null;
    principal: Principal;
    clientContactId: string | null;
  }>(UNRESOLVED_PRINCIPAL);
  // A sign-in that still owes its second factor is not a completed sign-in, so
  // its audit row waits until the owner check passes.
  const loginAuditPending = useRef(false);

  useEffect(() => {
    const supabase = getSupabase();
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoadingAuth(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_OUT') {
        loginAuditPending.current = false;
        setMfaEval(UNRESOLVED_GATE);
        setPrincipalEval(UNRESOLVED_PRINCIPAL);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Computes the MFA gate on every session change (completeMfa also re-gates). Not inside onAuthStateChange: calling
  // supabase.auth.* from that callback can deadlock on the client's internal lock.
  useEffect(() => {
    if (isLoadingAuth) return;
    let cancelled = false;
    const userId = session?.user?.id ?? null;
    void (async () => {
      const gate = await evaluateMfaGate(session);
      if (!cancelled) setMfaEval({ userId, gate });
    })();
    return () => { cancelled = true; };
  }, [session, isLoadingAuth]);

  // Keyed on user id, not access token: an hourly token refresh must not blank the app.
  const currentUserId = session?.user?.id ?? null;
  const mfaGate: MfaGate = mfaEval.userId === currentUserId ? mfaEval.gate : 'checking';

  useEffect(() => {
    if (!currentUserId || mfaGate !== 'satisfied') return;
    let cancelled = false;
    void (async () => {
      const result = await resolvePrincipal();
      if (cancelled) return;
      setPrincipalEval({ userId: currentUserId, ...result });
      if (result.principal === 'owner' && loginAuditPending.current) {
        loginAuditPending.current = false;
        void recordAudit(currentUserId, 'owner_login');
      }
    })();
    return () => { cancelled = true; };
  }, [currentUserId, mfaGate]);

  const current = principalEval.userId === currentUserId ? principalEval : UNRESOLVED_PRINCIPAL;
  const principal: Principal = current.principal;

  const login = async (email: string, password: string): Promise<LoginResult> => {
    // Armed before the call: the SIGNED_IN event can start the owner check before
    // signInWithPassword resolves.
    loginAuditPending.current = true;
    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (!error && data.session) return 'ok';
      loginAuditPending.current = false;
      return error && isAuthRetryableFetchError(error) ? 'unreachable' : 'rejected';
    } catch {
      loginAuditPending.current = false;
      return 'unreachable';
    }
  };

  /**
   * After a verified code, re-gate directly. Leaving it to the effect would depend
   * on getSession handing back a new session object; the same object would not
   * re-run the effect, and the challenge would never clear.
   */
  const completeMfa = async () => {
    const { data } = await getSupabase().auth.getSession();
    setSession(data.session);
    setMfaEval({ userId: data.session?.user?.id ?? null, gate: await evaluateMfaGate(data.session) });
  };

  const logout = async () => {
    // Logged before signing out, while the token is still valid. A session that
    // never finished signing in gets no sign-out row either.
    if (currentUserId && principal === 'owner' && !loginAuditPending.current) {
      await recordAudit(currentUserId, 'owner_logout');
    }
    await getSupabase().auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoadingAuth,
        mfaGate,
        principal,
        clientContactId: current.clientContactId,
        login,
        completeMfa,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
