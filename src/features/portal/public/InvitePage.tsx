import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { links } from '@/features/links';
import { invokePublicEdge } from '@/lib/publicEdge';
import { getErrorMessage } from '@/lib/errors';
import { passwordProblem, PASSWORD_RULES } from '@/lib/passwordRules';

/**
 * Must equal PORTAL_LOGIN_PENDING_KEY in src/lib/auth.tsx (this public page may not import
 * that module, which loads supabase-js); portal/__tests__/invitePage.test.tsx holds them equal.
 */
export const INVITE_LOGIN_PENDING_KEY = 'open-crm:portal-login-pending';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

const validateAnswer = z.union([
  z.object({
    valid: z.literal(true),
    contact: z.object({ first_name: z.string().nullable(), last_name: z.string().nullable(), email: z.string() }),
  }),
  z.object({ valid: z.literal(false), reason: z.enum(['not_found', 'used', 'revoked', 'expired']) }),
]);
const acceptAnswer = z.object({ success: z.literal(true), email: z.string() });

type Invitee = { first_name: string | null; email: string };
type View =
  | { kind: 'checking' }
  | { kind: 'invalid'; reason: 'not_found' | 'used' | 'revoked' | 'expired' | 'unreachable' }
  | { kind: 'form'; invitee: Invitee }
  | { kind: 'signed-up'; email: string };

/** The token arrives in the fragment (`/invite#token=...`), which never reaches a server log. */
function readToken(hash: string, pathname: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (fromHash && TOKEN.test(fromHash)) return fromHash;
  const fromPath = pathname.split('/').filter(Boolean)[1];
  return fromPath && TOKEN.test(fromPath) ? fromPath : null;
}

const INVALID_TEXT: Record<Extract<View, { kind: 'invalid' }>['reason'], string> = {
  not_found: 'This invitation link is not valid. It may have been replaced by a newer one.',
  used: 'This invitation has already been used. Sign in with the password you chose.',
  revoked: 'This invitation no longer works. Ask us for a new one.',
  expired: 'This invitation has expired. Ask us for a new one.',
  unreachable: 'We could not check this link just now. Try again in a minute.',
};

/** Where a portal invitation lands: check the link, choose a password, and go straight in. */
export function InvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readToken(location.hash, location.pathname));
  const [view, setView] = useState<View>(() => (token ? { kind: 'checking' } : { kind: 'invalid', reason: 'not_found' }));

  // The token leaves the address bar at once, so it is not left in history or shared by copy.
  useEffect(() => {
    if (location.hash || location.pathname !== '/invite') {
      window.history.replaceState(window.history.state, '', '/invite');
    }
    // Only on arrival.
  }, []);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    invokePublicEdge('validate-portal-invite', { token }, { parse: (v) => validateAnswer.parse(v), signal: controller.signal }).then(
      (answer) => {
        if (answer.valid) setView({ kind: 'form', invitee: { first_name: answer.contact.first_name, email: answer.contact.email } });
        else setView({ kind: 'invalid', reason: answer.reason });
      },
      () => {
        if (!controller.signal.aborted) setView({ kind: 'invalid', reason: 'unreachable' });
      },
    );
    return () => controller.abort();
  }, [token]);

  const signIn = async (email: string, password: string) => {
    try {
      window.sessionStorage.setItem(INVITE_LOGIN_PENDING_KEY, '1');
    } catch {
      // The first sign-in just goes unrecorded.
    }
    try {
      // Loaded only now, after the account exists: this page itself never carries supabase-js.
      const { getSupabase } = await import('@/lib/supabase');
      const { error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (error) throw error;
      navigate(links.portalHome(), { replace: true });
    } catch {
      setView({ kind: 'signed-up', email });
    }
  };

  return (
    <PublicPage title="Set up your portal sign-in">
      {view.kind === 'checking' && <p className="text-[14px] text-muted-foreground">Checking your invitation...</p>}
      {view.kind === 'invalid' && (
        <div className="flex flex-col gap-3 text-[14px]">
          <p role="alert">{INVALID_TEXT[view.reason]}</p>
          {(view.reason === 'used' || view.reason === 'unreachable') && (
            <p>
              <Link to={links.portalHome()} className="underline underline-offset-2">
                Go to sign in
              </Link>
            </p>
          )}
        </div>
      )}
      {view.kind === 'form' && token && <AccountSetupForm token={token} invitee={view.invitee} onDone={signIn} />}
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

function AccountSetupForm({
  token,
  invitee,
  onDone,
}: {
  token: string;
  invitee: Invitee;
  onDone: (email: string, password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const rule = passwordProblem(password);
    if (rule) return setProblem(rule);
    if (password !== confirm) return setProblem('The two passwords do not match.');
    setProblem(null);
    setBusy(true);
    try {
      const answer = await invokePublicEdge('accept-portal-invite', { token, password }, { parse: (v) => acceptAnswer.parse(v) });
      await onDone(answer.email, password);
    } catch (err) {
      setProblem(getErrorMessage(err, 'Your sign-in was not set up. Try again.'));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 text-[14px]" noValidate>
      <p>
        {invitee.first_name ? `Welcome, ${invitee.first_name}. ` : 'Welcome. '}
        Choose a password for <span className="font-medium">{invitee.email}</span>.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-password">Password</Label>
        <Input
          id="invite-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="invite-password-rules"
          required
        />
        <ul id="invite-password-rules" className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
          {PASSWORD_RULES.map((rule) => (
            <li key={rule.label} className={rule.ok(password) ? 'text-foreground' : undefined}>
              {rule.ok(password) ? 'Done: ' : ''}
              {rule.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-confirm">Password again</Label>
        <Input id="invite-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {problem && (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
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
