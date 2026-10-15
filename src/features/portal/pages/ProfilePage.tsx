import { Suspense, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { portalProfileSections } from '@/features/registry';
import { formatPhoneNumber, NO_VALUE_TEXT } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import { changePassword, sendReauthenticationCode, verifyCurrentPassword } from '@/lib/passwordChange';
import { passwordProblem, PASSWORD_RULES } from '@/lib/passwordRules';
import { getMyContact, portalKeys } from '../api';

/** The client's details (read-only) and their password. */
export function PortalProfilePage() {
  const { session, isViewAsClientSession: viewing } = useAuth();
  const contact = useQuery({ queryKey: portalKeys.myContact(), queryFn: getMyContact });
  const c = contact.data;
  const rows: Array<[string, string | null | undefined]> = c
    ? [
        ['Name', c.full_name],
        ['Email', session?.user?.email ?? c.email],
        ['Phone', c.phone ? formatPhoneNumber(c.phone) : null],
        ['Business', c.business_name],
      ]
    : [];

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Your account</h1>
      <section aria-labelledby="profile-details-heading" className="rounded-lg border border-border bg-card">
        <h2 id="profile-details-heading" className="border-b border-border px-4 py-2.5 text-[14px] font-semibold">
          Your details
        </h2>
        {contact.isPending && <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading...</p>}
        {contact.isError && (
          <p role="alert" className="px-4 py-3 text-[13px] text-destructive">
            Could not load your details: {getErrorMessage(contact.error)}
          </p>
        )}
        {c && (
          <dl className="divide-y divide-border">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-3 px-4 py-2.5 text-[14px]">
                <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 flex-1 break-words">{value || NO_VALUE_TEXT}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">To change your details, send us a message.</p>
      </section>
      <section aria-labelledby="profile-password-heading" className="rounded-lg border border-border bg-card">
        <h2 id="profile-password-heading" className="border-b border-border px-4 py-2.5 text-[14px] font-semibold">
          Password
        </h2>
        {viewing ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">Password and two-factor settings are off while viewing as client.</p>
        ) : (
          <PasswordChangeForm email={session?.user?.email ?? ''} />
        )}
      </section>
      {/* Two-factor and the like, from the features that own them; never during a view. */}
      {!viewing &&
        portalProfileSections.map(({ key, Component }) => (
          <Suspense key={key} fallback={null}>
            <Component />
          </Suspense>
        ))}
    </div>
  );
}

/**
 * Change the password: the current one is checked first by signing in with it on a throwaway
 * client (verifyCurrentPassword), then the new one is saved and every OTHER session of this
 * account is signed out (this one stays).
 *
 * The current-password check runs in the browser, so Auth may also require its own proof
 * (secure_password_change): changePassword then answers 'reauthentication_needed', the form
 * asks Auth to email a code (sendReauthenticationCode), and the save is retried with it.
 */
function PasswordChangeForm({ email }: { email: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Set once Auth has emailed a code: the next submit sends it with the new password. */
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');

  const finish = async () => {
    await getSupabase().auth.signOut({ scope: 'others' }).catch(() => {
      // The password changed; other devices sign out when their session next refreshes.
    });
    setCurrent('');
    setNext('');
    setConfirm('');
    setCode('');
    setAwaitingCode(false);
    toast.success('Password changed. Other devices are signed out.');
  };

  const askForCode = async () => {
    try {
      await sendReauthenticationCode();
    } catch (err) {
      setProblem(getErrorMessage(err, 'We could not send the confirmation code. Try again.'));
      return;
    }
    setCode('');
    setAwaitingCode(true);
  };

  const submitCode = async () => {
    setBusy(true);
    try {
      const result = await changePassword(next, code.trim());
      if (result === 'ok') await finish();
      else if (result === 'code_not_valid') setProblem('That code did not work. Check the email and try again.');
      else await askForCode();
    } catch (err) {
      setProblem(getErrorMessage(err, 'The password was not changed.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (awaitingCode) {
      setProblem(null);
      return submitCode();
    }
    const rule = passwordProblem(next);
    if (rule) return setProblem(rule);
    if (next !== confirm) return setProblem('The two new passwords do not match.');
    if (next === current) return setProblem('Choose a password you have not used here.');
    setProblem(null);
    setBusy(true);
    try {
      // On a throwaway client: this session (and its second factor) stays as it is.
      if (!(await verifyCurrentPassword(email, current))) {
        setProblem('Your current password is not right.');
        return;
      }
      // The server decides: without a recent sign-in it asks for the emailed code first.
      if ((await changePassword(next)) === 'ok') await finish();
      else await askForCode();
    } catch (err) {
      setProblem(getErrorMessage(err, 'The password was not changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 px-4 py-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="new-password-rules" required />
        <ul id="new-password-rules" className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
          {PASSWORD_RULES.map((rule) => (
            <li key={rule.label} className={rule.ok(next) ? 'text-foreground' : undefined}>
              {rule.ok(next) ? 'Done: ' : ''}
              {rule.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm-password">New password again</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {awaitingCode && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reauth-code">Code from the email</Label>
          <Input
            id="reauth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-describedby="reauth-code-help"
            required
          />
          <p id="reauth-code-help" className="text-[12px] text-muted-foreground">
            To confirm it is you, we emailed a code to {email}. Enter it to save the new password.
          </p>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy || !current || !next || !confirm || (awaitingCode && !code.trim())}>
          {busy ? 'Saving...' : awaitingCode ? 'Confirm and change password' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}
