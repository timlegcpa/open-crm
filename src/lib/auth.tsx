import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { z } from 'zod';
import { invokeEdge } from '@/lib/edge';
import { getSupabase } from '@/lib/supabase';

/**
 * Whether the session still owes a second factor.
 * 'checking':   not resolved yet; render nothing protected (fail closed)
 * 'required':   the user holds a verified factor but the session is still aal1
 * 'satisfied':  no verified factor, or already aal2
 */
export type MfaGate = 'checking' | 'required' | 'satisfied';

/**
 * Who the signed-in account is, as the DATABASE decides it (never a claim in the token):
 * 'owner':   is_owner() is true: the owner app
 * 'client':  get_client_contact_id() names a contact (an active portal account): the portal
 * 'none':    signed in, but neither: no access
 * 'error':   the check could not be answered: fail closed, no access
 * 'checking':  not answered yet: render nothing protected
 */
export type Principal = 'checking' | 'owner' | 'client' | 'none' | 'error';

/** 'unreachable' means the Auth server never answered, not that the password was wrong. */
export type LoginResult = 'ok' | 'rejected' | 'unreachable';

/**
 * The owner looking at the portal through one client's sign-in ("View as client"), in
 * this browser. The session the tab holds is the client's, minted for the owner and
 * read-only in the database; this record is how the tab knows to show the banner and
 * how it gets the owner's own session back.
 */
export interface ViewAsClient {
  /** The impersonation_sessions row. */
  sessionRowId: string;
  contactId: string;
  contactName: string;
  startedAt: string;
  /** The client's sign-in user: whose session the browser holds during the view. */
  clientUserId: string;
}

interface AuthContextType {
  session: Session | null;
  isLoadingAuth: boolean;
  mfaGate: MfaGate;
  principal: Principal;
  /** The contact the signed-in client is, when `principal` is 'client'; otherwise null. */
  clientContactId: string | null;
  /** Set while this browser is viewing the portal as a client (every tab shares the view). */
  viewAsClient: ViewAsClient | null;
  /**
   * The signed-in client session is a View-as-client session, by the record above OR by the
   * database's own answer (a tab whose storage lost the record still shows the banner).
   */
  isViewAsClientSession: boolean;
  /** The session came from a password-recovery link: the next step is choosing a new password. */
  isRecovery: boolean;
  clearRecovery: () => void;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: () => Promise<void>;
  /**
   * Sign out of THIS browser only ({ scope: 'local' }, never global). While viewing as a
   * client it ends the view instead and hands the owner's session back: a global
   * sign-out there would sign the real client out of every device they use.
   */
  logout: () => Promise<void>;
  /** The portal's inactivity timeout: recorded as an expired session, then a sign-out. */
  expireSession: () => Promise<void>;
  /** Owner only: start viewing the portal as this contact's client. */
  startViewAsClient: (contactId: string) => Promise<void>;
  /** End the view and restore the owner's session. */
  endViewAsClient: () => Promise<void>;
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
  /** The database says this client session is a View-as-client session (is_view_as_client()). */
  serverViewAsClient: boolean;
}

/**
 * The owner check first; only an account that is not the owner is asked whether it is a
 * client, so an owner session never calls the client RPC. Any failure is 'error'.
 */
async function resolvePrincipal(): Promise<PrincipalResult> {
  const fail: PrincipalResult = { principal: 'error', clientContactId: null, serverViewAsClient: false };
  try {
    const owner = await getSupabase().rpc('is_owner');
    if (owner.error) return fail;
    if (owner.data === true) return { principal: 'owner', clientContactId: null, serverViewAsClient: false };
    const client = await getSupabase().rpc('get_client_contact_id');
    if (client.error) return fail;
    if (typeof client.data !== 'string' || client.data === '') return { principal: 'none', clientContactId: null, serverViewAsClient: false };
    // Display only: the database enforces read-only whatever this answers.
    const view = await getSupabase().rpc('is_view_as_client');
    return { principal: 'client', clientContactId: client.data, serverViewAsClient: !view.error && view.data === true };
  } catch {
    return fail;
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

/**
 * A client's session lifecycle, through the log-portal-event function (it records the
 * caller's address, which the browser cannot be trusted to). Never throws: logging must
 * not block signing in or out. The function skips a View-as-client session itself.
 */
async function recordPortalEvent(action: 'login' | 'logout' | 'session_expired'): Promise<void> {
  try {
    await invokeEdge('log-portal-event', { action });
  } catch (err) {
    console.warn(`Portal event ${action} was not recorded`, err);
  }
}

// ---------------------------------------------------------------------------
// View as client. The browser keeps ONE Auth session for every tab of the app (Supabase
// stores it in localStorage), so starting a view in one tab hands the client's session to
// every tab. The owner's stashed session and the view's record therefore live beside it,
// in localStorage too: every tab shows the banner, and Exit or Sign out in ANY tab gets
// the owner's session back, rather than stranding the owner in a tab that never saw the
// start. The stash is no new exposure: the owner's own session sat in the same storage a
// moment before. Every key is written and cleared here alone (clearViewAsClientState).
// A per-tab Auth client would keep the other tabs as the owner; that is a change to
// src/lib/supabase.ts, outside this file.
// ---------------------------------------------------------------------------

const OWNER_STASH_KEY = 'open-crm:view-as-client:owner-session';
const VIEW_STATE_KEY = 'open-crm:view-as-client';
/**
 * Set by the invitation page right before it signs the new client in. That page runs
 * without this provider, so the provider reads the flag once at mount to record the
 * first sign-in like any other. The invitation page carries the same literal (a public
 * page may not import this module); portal/__tests__/auth.test.ts holds the two equal.
 */
export const PORTAL_LOGIN_PENDING_KEY = 'open-crm:portal-login-pending';
/** An Exit that hangs must not trap the owner in the client's view. */
const END_TIMEOUT_MS = 8000;
/** Read by the sign-in screen to say why the portal signed someone out. */
export const SESSION_EXPIRED_KEY = 'open-crm:portal-session-expired';

const ownerStashSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) });
const viewStateSchema = z.object({
  sessionRowId: z.string().uuid(),
  contactId: z.string().uuid(),
  contactName: z.string(),
  startedAt: z.string(),
  clientUserId: z.string().min(1),
});
const startAnswer = z.object({
  session_id: z.string().uuid(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  contact_id: z.string().uuid(),
  contact_name: z.string(),
  client_user_id: z.string().min(1),
});

function readShared<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeShared(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

/** Forget the browser's View-as-client state and the owner's stashed session. */
export function clearViewAsClientState(): void {
  for (const key of [OWNER_STASH_KEY, VIEW_STATE_KEY]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing was stored either.
    }
  }
}

function markSessionExpired(): void {
  try {
    window.sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
  } catch {
    // The explanation is a courtesy; signing out still happens.
  }
}

/** Read without removing (a render may run twice); the flag is cleared once the sign-in is recorded or abandoned. */
function loginPendingFromInvite(): boolean {
  try {
    return window.sessionStorage.getItem(PORTAL_LOGIN_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function clearLoginPendingFlag(): void {
  try {
    window.sessionStorage.removeItem(PORTAL_LOGIN_PENDING_KEY);
  } catch {
    // Nothing stored.
  }
}

/** View as client could not be ended: the view is back on, and the owner can try again. */
export class ViewNotEndedError extends Error {
  constructor() {
    super('View as client could not be ended. Try again in a moment.');
    this.name = 'ViewNotEndedError';
  }
}

const UNRESOLVED_GATE = { userId: null, gate: 'checking' } as const;
const UNRESOLVED_PRINCIPAL = { userId: null, principal: 'checking', clientContactId: null, serverViewAsClient: false } as const;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);
  const [viewAsClient, setViewAsClient] = useState<ViewAsClient | null>(() => readShared(VIEW_STATE_KEY, viewStateSchema));
  // Each result is stored WITH the user it was computed for, and read back only
  // when that user is still the current one, so a session change re-gates on the
  // same render that exposes it instead of one frame later. Both are cleared on
  // sign-out, so signing back in as the same user never reuses an old answer.
  const [mfaEval, setMfaEval] = useState<{ userId: string | null; gate: MfaGate }>(UNRESOLVED_GATE);
  const [principalEval, setPrincipalEval] = useState<{
    userId: string | null;
    principal: Principal;
    clientContactId: string | null;
    serverViewAsClient: boolean;
  }>(UNRESOLVED_PRINCIPAL);
  // A sign-in that still owes its second factor is not a completed sign-in, so its
  // record (the owner's audit row, a client's login event) waits until the principal
  // check passes.
  const loginAuditPending = useRef(loginPendingFromInvite());

  useEffect(() => {
    const supabase = getSupabase();
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoadingAuth(false);
    });
    // Another tab started or ended a view: this tab follows (a storage read, no auth call).
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === VIEW_STATE_KEY) setViewAsClient(readShared(VIEW_STATE_KEY, viewStateSchema));
    };
    window.addEventListener('storage', onStorage);
    // Nothing here may call supabase.auth.*: that can deadlock on the client's lock.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_IN') setViewAsClient(readShared(VIEW_STATE_KEY, viewStateSchema));
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
      else if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setIsRecovery(false);
      if (event === 'SIGNED_OUT') {
        loginAuditPending.current = false;
        clearLoginPendingFlag();
        setMfaEval(UNRESOLVED_GATE);
        setPrincipalEval(UNRESOLVED_PRINCIPAL);
        // The browser's session is gone, the view's with it. If the minted session dies
        // mid-view (the stale sweep, a failed refresh), the owner signs in again: the stash
        // is dropped rather than restored from here, where no auth call may run.
        clearViewAsClientState();
        setViewAsClient(null);
      }
    });
    return () => {
      subscription.unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
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
      if (loginAuditPending.current && (result.principal === 'owner' || result.principal === 'client')) {
        loginAuditPending.current = false;
        clearLoginPendingFlag();
        if (result.principal === 'owner') void recordAudit(currentUserId, 'owner_login');
        else void recordPortalEvent('login');
      }
    })();
    return () => { cancelled = true; };
  }, [currentUserId, mfaGate]);

  const current = principalEval.userId === currentUserId ? principalEval : UNRESOLVED_PRINCIPAL;
  const principal: Principal = current.principal;

  const login = async (email: string, password: string): Promise<LoginResult> => {
    // Armed before the call: the SIGNED_IN event can start the principal check before
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

  const startViewAsClient = useCallback(async (contactId: string) => {
    const supabase = getSupabase();
    const { data } = await supabase.auth.getSession();
    const own = data.session;
    if (!own?.access_token || !own.refresh_token) throw new Error('Sign in again first.');
    // The owner's session is stashed BEFORE the swap: once the client's session replaces
    // it in the browser, this is the only way back.
    writeShared(OWNER_STASH_KEY, { access_token: own.access_token, refresh_token: own.refresh_token });
    let answer: z.infer<typeof startAnswer>;
    try {
      answer = await invokeEdge('admin-impersonate', { contact_id: contactId }, { parse: (v) => startAnswer.parse(v) });
    } catch (err) {
      clearViewAsClientState();
      throw err;
    }
    const state: ViewAsClient = {
      sessionRowId: answer.session_id,
      contactId: answer.contact_id,
      contactName: answer.contact_name,
      startedAt: new Date().toISOString(),
      clientUserId: answer.client_user_id,
    };
    writeShared(VIEW_STATE_KEY, state);
    setViewAsClient(state);
    const { error } = await supabase.auth.setSession({ access_token: answer.access_token, refresh_token: answer.refresh_token });
    if (error) {
      // The owner's session is still the one in the browser: close the row it opened.
      clearViewAsClientState();
      setViewAsClient(null);
      await invokeEdge('admin-impersonate-end', { session_id: answer.session_id }, { timeoutMs: END_TIMEOUT_MS }).catch((endErr: unknown) => {
        console.warn('View as client could not be closed', endErr);
      });
      throw error;
    }
  }, []);

  const endViewAsClient = useCallback(async () => {
    const supabase = getSupabase();
    const state = readShared(VIEW_STATE_KEY, viewStateSchema);
    const stash = readShared(OWNER_STASH_KEY, ownerStashSchema);
    if (!stash) {
      clearViewAsClientState();
      setViewAsClient(null);
      // Another tab may have ended the view a moment ago: then this browser already holds
      // the owner's session again, and signing out would sign the owner out everywhere.
      const { data: held } = await supabase.auth.getSession();
      const heldUser = held.session?.user?.id ?? null;
      const stillClient = state ? heldUser === state.clientUserId : (await supabase.rpc('is_view_as_client')).data === true;
      // Nothing to go back to: drop the client's session from this browser only.
      if (stillClient) await supabase.auth.signOut({ scope: 'local' });
      return;
    }
    // The client session the view holds, kept in case the end fails and the view goes back.
    const minted = (await supabase.auth.getSession()).data.session;
    const { error } = await supabase.auth.setSession(stash);
    if (error) {
      clearViewAsClientState();
      setViewAsClient(null);
      await supabase.auth.signOut({ scope: 'local' });
      return;
    }
    // As the owner again: close the row and revoke the client session it minted.
    if (state) {
      try {
        await invokeEdge('admin-impersonate-end', { session_id: state.sessionRowId }, { timeoutMs: END_TIMEOUT_MS });
      } catch (err) {
        // Not ended: the server could not revoke the minted session (or never answered), so
        // its row stays open. The view goes back on, so the owner sees it is still live and
        // can try again. The owner's session is stashed afresh first: restoring it may have
        // used up the refresh token the old stash held.
        console.warn('View as client could not be ended', err);
        const owner = (await supabase.auth.getSession()).data.session;
        if (owner?.access_token && owner.refresh_token) {
          writeShared(OWNER_STASH_KEY, { access_token: owner.access_token, refresh_token: owner.refresh_token });
        }
        const back = minted
          ? await supabase.auth.setSession({ access_token: minted.access_token, refresh_token: minted.refresh_token })
          : { error: new Error('no client session to go back to') };
        if (!back.error) throw new ViewNotEndedError();
        // The view cannot be put back: the owner keeps their own session, and the open row
        // is left to the stale sweep, which revokes it.
        console.warn('View as client could not be put back; the stale sweep will close it', back.error);
      }
    }
    clearViewAsClientState();
    setViewAsClient(null);
  }, []);

  const isViewSession = viewAsClient !== null || (principal === 'client' && current.serverViewAsClient);

  const logout = async () => {
    if (isViewSession) {
      // A view that could not be ended stays on, and the caller hears why.
      await endViewAsClient();
      return;
    }
    // Recorded before signing out, while the token is still valid. A session that never
    // finished signing in gets no sign-out record either.
    if (currentUserId && !loginAuditPending.current) {
      if (principal === 'owner') await recordAudit(currentUserId, 'owner_logout');
      else if (principal === 'client') await recordPortalEvent('logout');
    }
    await getSupabase().auth.signOut({ scope: 'local' });
  };

  const expireSession = async () => {
    // While viewing as a client the owner gets their own session back, not a sign-in form,
    // so there is nothing to explain to them.
    if (isViewSession) {
      await logout();
      return;
    }
    markSessionExpired();
    if (principal === 'client') await recordPortalEvent('session_expired');
    await getSupabase().auth.signOut({ scope: 'local' });
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoadingAuth,
        mfaGate,
        principal,
        clientContactId: current.clientContactId,
        viewAsClient,
        isViewAsClientSession: viewAsClient !== null || (principal === 'client' && current.serverViewAsClient),
        isRecovery,
        clearRecovery: () => setIsRecovery(false),
        login,
        completeMfa,
        logout,
        expireSession,
        startViewAsClient,
        endViewAsClient,
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
