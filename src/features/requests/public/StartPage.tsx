import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { isEdgeError, invokePublicEdge } from '@/lib/publicEdge';
import { passwordProblem, PASSWORD_RULES } from '@/lib/passwordRules';

/**
 * Must equal PORTAL_LOGIN_PENDING_KEY in src/lib/auth.tsx (this public page may not import
 * that module, which loads supabase-js); requests/__tests__/StartPage.test.tsx holds them equal.
 */
export const START_LOGIN_PENDING_KEY = 'open-crm:portal-login-pending';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

const acceptAnswer = z.object({
  success: z.literal(true),
  email: z.string(),
  contact_id: z.string(),
  needs_list_id: z.string().nullable(),
});

/** The token arrives in the fragment (`/start#token=...`), which never reaches a server log. */
export function readStartToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && TOKEN.test(token) ? token : null;
}

type View = { kind: 'form' } | { kind: 'invalid' } | { kind: 'signed-up'; email: string };

/**
 * Where a request's start link lands, for a contact with no portal account yet: choose a
 * password, and go straight to the request.
 */
export function StartPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readStartToken(location.hash));
  const [view, setView] = useState<View>(() => (token ? { kind: 'form' } : { kind: 'invalid' }));

  // The token leaves the address bar at once, so it is not left in history or shared by copy.
  useEffect(() => {
    if (location.hash || location.pathname !== '/start') {
      window.history.replaceState(window.history.state, '', '/start');
    }
    // Only on arrival.
  }, []);

  const signIn = async (email: string, password: string, listId: string | null) => {
    try {
      window.sessionStorage.setItem(START_LOGIN_PENDING_KEY, '1');
    } catch {
      // The first sign-in just goes unrecorded.
    }
    try {
      // Loaded only now, after the account exists: this page itself never carries supabase-js.
      const { getSupabase } = await import('@/lib/supabase');
      const { error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (error) throw error;
      navigate(listId ? links.portalRequest(listId) : links.portalHome(), { replace: true });
    } catch {
      setView({ kind: 'signed-up', email });
    }
  };

  return (
    <PublicPage title="Set up your portal sign-in">
      {view.kind === 'invalid' && (
        <div className="flex flex-col gap-3 text-[14px]">
          <p role="alert">This link is not complete. Open it again from the email you received, or ask for a new one.</p>
          <p>
            <Link to={links.portalHome()} className="underline underline-offset-2">
              Go to sign in
            </Link>
          </p>
        </div>
      )}
      {view.kind === 'form' && token && <StartForm token={token} onDone={signIn} />}
      {view.kind === 'signed-up' && (
        <div className="flex flex-col gap-3 text-[14px]">
          <p>Your sign-in is ready. Sign in with {view.email} and the password you just chose.</p>
          <p>
            <Link to={links.portalHome()} className="underline underline-offset-2">
              Go to sign in
            </Link>
          </p>
        </div>
      )}
    </PublicPage>
  );
}

function StartForm({ token, onDone }: { token: string; onDone: (email: string, password: string, listId: string | null) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [used, setUsed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const rule = passwordProblem(password);
    if (rule) return setProblem(rule);
    if (password !== confirm) return setProblem('The two passwords do not match.');
    setProblem(null);
    setUsed(false);
    setBusy(true);
    try {
      const answer = await invokePublicEdge(
        'accept-start-link',
        { token, password, confirm_password: confirm },
        { parse: (v) => acceptAnswer.parse(v) },
      );
      await onDone(answer.email, password, answer.needs_list_id);
    } catch (err) {
      setUsed(isEdgeError(err) && (err.code === 'link_used' || err.code === 'already_registered'));
      setProblem(getErrorMessage(err, 'Your sign-in was not set up. Try again.'));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 text-[14px]" noValidate>
      <p>You have a request waiting. Choose a password to set up your secure portal sign-in.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="start-password">Password</Label>
        <Input
          id="start-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="start-password-rules"
          required
        />
        <ul id="start-password-rules" className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
          {PASSWORD_RULES.map((rule) => (
            <li key={rule.label} className={rule.ok(password) ? 'text-foreground' : undefined}>
              {rule.ok(password) ? 'Done: ' : ''}
              {rule.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="start-confirm">Password again</Label>
        <Input id="start-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {problem && (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      )}
      {used && (
        <p>
          <Link to={links.portalHome()} className="underline underline-offset-2">
            Go to sign in
          </Link>
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy || !password || !confirm}>
          {busy ? 'Setting up...' : 'Set up and sign in'}
        </Button>
      </div>
    </form>
  );
}
