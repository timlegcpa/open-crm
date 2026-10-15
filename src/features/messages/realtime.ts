import { useEffect, useId, useRef } from 'react';
import { getSupabase } from '@/lib/supabase';

/**
 * Live updates on client_messages. A callback never reads the payload: it refetches, and
 * RLS decides what comes back. Each subscriber gets its own channel name, so a double
 * mount or a second screen never takes over a listener that is still live.
 */
function useMessagesChannel(
  channel: string,
  config: { event: 'INSERT' | '*'; filter?: string },
  onEvent: () => void,
  enabled: boolean,
): void {
  const instance = useId();
  const callback = useRef(onEvent);
  useEffect(() => {
    callback.current = onEvent;
  });
  const { event, filter } = config;

  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabase();
    const subscription = supabase
      .channel(`${channel}:${instance}`)
      .on(
        'postgres_changes',
        { event, schema: 'public', table: 'client_messages', ...(filter ? { filter } : {}) },
        () => callback.current(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(subscription);
    };
  }, [channel, enabled, event, filter, instance]);
}

/**
 * The owner: every insert, update (a read) and delete, from any session, so an inbox or a
 * conversation open in one tab follows what another tab or device did. Unfiltered on
 * purpose: a delete event carries only the row's key, so a contact filter would drop it,
 * and the owner may see every row anyway. Owner screens only.
 */
export function useOwnerMessageChanges(channel: string, onChange: () => void): void {
  useMessagesChannel(channel, { event: '*' }, onChange, true);
}

/**
 * A client: new messages on its own conversation only. INSERT alone, filtered to the
 * contact: update and delete events are not filtered by RLS, so a client never listens for
 * them. A delete by the owner shows on the next refetch.
 */
export function useClientNewMessages(contactId: string | null, onInsert: () => void): void {
  useMessagesChannel('portal-conversation', { event: 'INSERT', filter: `contact_id=eq.${contactId}` }, onInsert, contactId !== null);
}
