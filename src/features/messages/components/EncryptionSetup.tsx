import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { ENCRYPTION_PASSWORD_HINT, encryptionPasswordProblem } from '../encryptionPassword';
import { messagesKeys } from '../keys';
import { setUpOwnerKey } from '../ownerKey';
import { holdSessionKey, sessionGeneration } from '../keySession';
import { PasswordField } from './PasswordField';
import { RecoveryKeyDialog } from './RecoveryKeyDialog';

/** First run: choose an encryption password, make the key, show the recovery key once. */
export function EncryptionSetup() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ recoveryKey: string; sessionKey: CryptoKey; startedIn: number } | null>(null);

  const problem = password ? encryptionPasswordProblem(password) : null;
  const mismatch = confirm !== '' && confirm !== password;
  const ready = password !== '' && problem === null && confirm === password && !working;
  const userId = session?.user?.id ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !userId) return;
    setWorking(true);
    setError(null);
    try {
      const startedIn = sessionGeneration();
      setDone({ ...(await setUpOwnerKey(userId, password)), startedIn });
      setPassword('');
      setConfirm('');
    } catch (err) {
      setError(getErrorMessage(err, 'Secure messages could not be set up.'));
    } finally {
      setWorking(false);
    }
  };

  const finish = () => {
    if (!done || !userId) return;
    holdSessionKey(userId, done.sessionKey, done.startedIn);
    setDone(null);
    // Only now: refreshing the key row flips this screen away, and doing it while the
    // recovery key is on screen would take the one view of it with it.
    void queryClient.invalidateQueries({ queryKey: messagesKeys.ownerKey() });
  };

  return (
    <>
      <form onSubmit={(e) => void submit(e)} className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border bg-card p-6" aria-label="Set up secure messages">
        <div className="flex flex-col items-center gap-2 text-center">
          <ShieldCheck className="size-10 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-semibold">Set up secure messages</h2>
          <p className="text-sm text-muted-foreground">
            Choose an encryption password. Clients' messages are encrypted so only it can open them, and you enter it
            once each session to read them.
          </p>
        </div>
        <PasswordField
          id="encryption-setup-password"
          label="Encryption password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={ENCRYPTION_PASSWORD_HINT}
          error={problem}
        />
        <PasswordField
          id="encryption-setup-confirm"
          label="Confirm encryption password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={mismatch ? 'The two passwords do not match.' : null}
        />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={!ready}>
          {working && <Loader2 className="animate-spin" aria-hidden="true" />}
          {working ? 'Making your key...' : 'Set up secure messages'}
        </Button>
      </form>
      {done && <RecoveryKeyDialog recoveryKey={done.recoveryKey} onClose={finish} />}
    </>
  );
}
