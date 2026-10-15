import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { getErrorMessage } from '@/lib/errors';
import { useEncryptionSession } from '../keySession';
import { EncryptionSetup } from './EncryptionSetup';
import { EncryptionUnlock } from './EncryptionUnlock';

/**
 * What stands between the owner and a conversation, in this order: loading, not set up,
 * locked, then the children with the unlocked key. The key being held IS the unlocked
 * state; there is no second flag that could disagree with it.
 */
export function EncryptionGate({ children }: { children: (privateKey: CryptoKey) => ReactNode }) {
  const { isLoading, error, ownerKey, privateKey, unlock, holdAfter } = useEncryptionSession();

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error) {
    return <p role="alert" className="text-sm text-destructive">Could not load your message key: {getErrorMessage(error)}</p>;
  }
  if (!ownerKey) return <EncryptionSetup />;
  if (!privateKey) return <EncryptionUnlock ownerKey={ownerKey} onUnlock={unlock} holdAfter={holdAfter} />;
  return <>{children(privateKey)}</>;
}
