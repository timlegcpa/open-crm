import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { links } from '@/features/links';
import { getErrorMessage } from '@/lib/errors';
import { PasswordField } from './components/PasswordField';
import { ENCRYPTION_PASSWORD_HINT, encryptionPasswordProblem } from './encryptionPassword';
import { useEncryptionSession } from './keySession';
import { messagesKeys } from './keys';
import { changeEncryptionPassword } from './ownerKey';

/** Settings > Secure messages: change the encryption password (the same key, re-wrapped). */
export function EncryptionSettings() {
  const queryClient = useQueryClient();
  const { isLoading, error, ownerKey, holdAfter } = useEncryptionSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = next ? encryptionPasswordProblem(next) : null;
  const mismatch = confirm !== '' && confirm !== next;
  const ready = current !== '' && next !== '' && problem === null && confirm === next && !working;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !ownerKey) return;
    setWorking(true);
    setFailure(null);
    try {
      await holdAfter(() => changeEncryptionPassword(ownerKey, current, next));
      await queryClient.invalidateQueries({ queryKey: messagesKeys.ownerKey() });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Encryption password changed.');
    } catch (err) {
      setFailure(getErrorMessage(err, 'The encryption password was not changed.'));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Panel title="Encryption password" icon={<KeyRound className="size-3.5" aria-hidden="true" />} bodyClassName="flex flex-col gap-4 p-4">
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">Could not load your message key: {getErrorMessage(error)}</p>
      ) : !ownerKey ? (
        <p className="text-sm text-muted-foreground">
          Secure messages are not set up yet.{' '}
          <Link to={links.messages()} className="text-link underline-offset-4 hover:underline">Set them up in Messages</Link>.
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-4" aria-label="Change encryption password">
          <p className="text-sm text-muted-foreground">
            The password that opens clients' messages. Changing it keeps every message readable; your recovery key stays
            the same.
          </p>
          <PasswordField id="encryption-current" label="Current encryption password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <PasswordField
            id="encryption-new"
            label="New encryption password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            hint={ENCRYPTION_PASSWORD_HINT}
            error={problem}
          />
          <PasswordField
            id="encryption-confirm"
            label="Confirm new encryption password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            error={mismatch ? 'The two passwords do not match.' : null}
          />
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
          <div>
            <Button type="submit" disabled={!ready}>
              {working && <Loader2 className="animate-spin" aria-hidden="true" />}
              Change encryption password
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
