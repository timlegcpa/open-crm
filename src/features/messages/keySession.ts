import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { messagesKeys } from './keys';
import { getOwnerKey, unlockOwnerKey, type OwnerKey } from './ownerKey';

/**
 * The unlocked private key: ONE in-memory copy for the page, held with the user it was
 * unlocked for. Module-level, so leaving Messages and coming back stays unlocked; a store
 * every screen subscribes to, so Lock in one place locks them all.
 *
 * It never outlives its owner session: a sign-out clears it (the auth listener below), and
 * a key held for another user than the one signed in now is treated as locked and cleared
 * on sight, whatever order the sign-in events arrive in.
 *
 * An unlock takes a while (PBKDF2, then the unwrap), and the session can end while it
 * runs. Every sign-out, change of account and Lock starts a new generation; work that
 * began in an earlier generation, or for another user than the one now signed in, is
 * refused when it tries to hold its key, so a late unlock can never bring the key back.
 */
interface Held {
  userId: string;
  key: CryptoKey;
}

let held: Held | null = null;
let generation = 0;
/** The account the auth listener last saw; undefined until it has seen one. */
let authUserId: string | null | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current generation, to pass back to holdSessionKey once the unlock work is done. */
export function sessionGeneration(): number {
  return generation;
}

/**
 * Hold `key` as the unlocked key for `userId`, if nothing ended the session since
 * `startedIn` (a sign-out, a change of account, a Lock) and `userId` is still the account
 * signed in. Returns whether it was held.
 */
export function holdSessionKey(userId: string, key: CryptoKey, startedIn: number): boolean {
  if (startedIn !== generation) return false;
  if (authUserId !== undefined && authUserId !== userId) return false;
  held = { userId, key };
  emit();
  return true;
}

/** Lock: drop the key everywhere, and refuse any unlock still running. */
export function lockEncryptionSession(): void {
  generation += 1;
  if (held === null) return;
  held = null;
  emit();
}

/** The held key, only when it was unlocked for `userId`. */
export function sessionKeyFor(userId: string | null): CryptoKey | null {
  return held && userId && held.userId === userId ? held.key : null;
}

let watching = false;

/** Clears the key when the account signs out or changes. Registered once, on first use. */
function watchAuth(): void {
  if (watching) return;
  watching = true;
  getSupabase().auth.onAuthStateChange((event, session) => {
    const userId = session?.user?.id ?? null;
    const changed = authUserId !== undefined && userId !== authUserId;
    authUserId = userId;
    if (event === 'SIGNED_OUT' || changed || (held && userId !== held.userId)) lockEncryptionSession();
  });
}

export interface EncryptionSession {
  /** The owner's key row is still loading. */
  isLoading: boolean;
  /** The key row could not be read. */
  error: unknown;
  /** The owner's key row, once loaded (null before setup). */
  ownerKey: OwnerKey | null;
  isSetup: boolean;
  /** The unlocked key; null while locked. Being non-null IS being unlocked. */
  privateKey: CryptoKey | null;
  /** Unlocks with the encryption password; throws when it is wrong. */
  unlock: (password: string) => Promise<void>;
  /**
   * Runs work that ends in an unlocked key (a recovery, a password change) and holds that
   * key, unless the session ended or changed meanwhile. Returns whether it was held.
   */
  holdAfter: (work: () => Promise<CryptoKey>) => Promise<boolean>;
  lock: () => void;
}

/** The owner's encryption state for the signed-in owner. */
export function useEncryptionSession(): EncryptionSession {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  watchAuth();

  const current = useSyncExternalStore(subscribe, () => held);
  const privateKey = current && current.userId === userId ? current.key : null;
  // A key unlocked for another account is never shown, and is dropped as soon as seen.
  useEffect(() => {
    if (current && current.userId !== userId) lockEncryptionSession();
  }, [current, userId]);

  const keyQuery = useQuery({
    queryKey: messagesKeys.ownerKey(),
    queryFn: getOwnerKey,
    // The key row changes only through this app's own setup, re-wrap and recovery, each of
    // which invalidates it.
    staleTime: Infinity,
  });
  const ownerKey = keyQuery.data ?? null;

  const unlock = useCallback(
    async (password: string) => {
      if (!ownerKey || !userId) throw new Error('Secure messages are not set up.');
      const startedIn = sessionGeneration();
      holdSessionKey(userId, await unlockOwnerKey(ownerKey, password), startedIn);
    },
    [ownerKey, userId],
  );

  const holdAfter = useCallback(
    async (work: () => Promise<CryptoKey>) => {
      const startedIn = sessionGeneration();
      const key = await work();
      return userId !== null && holdSessionKey(userId, key, startedIn);
    },
    [userId],
  );

  return {
    isLoading: keyQuery.isPending,
    error: keyQuery.error,
    ownerKey,
    isSetup: ownerKey !== null,
    privateKey,
    unlock,
    holdAfter,
    lock: lockEncryptionSession,
  };
}
