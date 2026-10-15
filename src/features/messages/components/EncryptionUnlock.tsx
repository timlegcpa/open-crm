import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';
import { toast } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getErrorMessage } from '@/lib/errors';
import { ENCRYPTION_PASSWORD_HINT, encryptionPasswordProblem } from '../encryptionPassword';
import { messagesKeys } from '../keys';
import { recoverOwnerKey, type OwnerKey } from '../ownerKey';
import { PasswordField } from './PasswordField';

/** Unlock for this session with the encryption password, or reset it with the recovery key. */
export function EncryptionUnlock({
  ownerKey,
  onUnlock,
  holdAfter,
}: {
  ownerKey: OwnerKey;
  onUnlock: (password: string) => Promise<void>;
  holdAfter: (work: () => Promise<CryptoKey>) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  return mode === 'password' ? (
    <PasswordUnlock onUnlock={onUnlock} onForgot={() => setMode('recovery')} />
  ) : (
    <RecoveryUnlock ownerKey={ownerKey} holdAfter={holdAfter} onBack={() => setMode('password')} />
  );
}

const CARD = 'mx-auto flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-6';

function PasswordUnlock({ onUnlock, onForgot }: { onUnlock: (password: string) => Promise<void>; onForgot: () => void }) {
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || working) return;
    setWorking(true);
    setFailed(false);
    try {
      await onUnlock(password);
    } catch (err) {
      // One message whatever the cause (it says nothing about the key); the cause goes to
      // the console, where a network failure can be told apart from a wrong password.
      console.warn('Unlock failed:', err);
      setFailed(true);
    } finally {
      setWorking(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={CARD} aria-label="Unlock messages">
      <div className="flex flex-col items-center gap-2 text-center">
        <Lock className="size-9 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">Unlock messages</h2>
        <p className="text-sm text-muted-foreground">Enter your encryption password to read messages in this session.</p>
      </div>
      <PasswordField
        id="encryption-unlock-password"
        label="Encryption password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        autoFocus
      />
      {failed && (
        <p role="alert" className="text-sm text-destructive">That password did not unlock your messages. Try again.</p>
      )}
      <Button type="submit" disabled={!password || working}>
        {working && <Loader2 className="animate-spin" aria-hidden="true" />}
        Unlock
      </Button>
      <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onForgot}>
        Forgot your encryption password? Use your recovery key
      </Button>
    </form>
  );
}

function RecoveryUnlock({
  ownerKey,
  holdAfter,
  onBack,
}: {
  ownerKey: OwnerKey;
  holdAfter: (work: () => Promise<CryptoKey>) => Promise<boolean>;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = password ? encryptionPasswordProblem(password) : null;
  const mismatch = confirm !== '' && confirm !== password;
  const ready = recoveryKey.trim() !== '' && password !== '' && problem === null && confirm === password && !working;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setWorking(true);
    setError(null);
    try {
      const unlocked = await holdAfter(() => recoverOwnerKey(ownerKey, recoveryKey, password));
      await queryClient.invalidateQueries({ queryKey: messagesKeys.ownerKey() });
      toast.success(unlocked ? 'Encryption password reset. Your messages are unlocked.' : 'Encryption password reset.');
    } catch (err) {
      setError(getErrorMessage(err, 'The encryption password was not reset.'));
    } finally {
      setWorking(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={CARD} aria-label="Reset encryption password">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-base font-semibold">Reset with your recovery key</h2>
        <p className="text-sm text-muted-foreground">
          Paste the recovery key you saved when you set up secure messages, then choose a new encryption password.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="encryption-recovery-key">Recovery key</Label>
        <Textarea
          id="encryption-recovery-key"
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
        />
      </div>
      <PasswordField
        id="encryption-recovery-password"
        label="New encryption password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={ENCRYPTION_PASSWORD_HINT}
        error={problem}
      />
      <PasswordField
        id="encryption-recovery-confirm"
        label="Confirm new encryption password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={mismatch ? 'The two passwords do not match.' : null}
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={!ready}>
        {working && <Loader2 className="animate-spin" aria-hidden="true" />}
        Reset and unlock
      </Button>
      <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onBack}>
        Back to unlock with your password
      </Button>
    </form>
  );
}
