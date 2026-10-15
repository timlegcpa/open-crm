import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PublicPage } from '@/components/layout/PublicPage';
import { Button } from '@/components/ui/button';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import { publicEdgeFetch } from '@/lib/publicEdge';

/**
 * /unsubscribe: the opt-out page the footer of every group email links to. The
 * email-unsubscribe function is the only implementation (token lookup, rate limit, the
 * suppression write); this page drives it with a plain fetch and no cookies, never the
 * Supabase client, since a public page must not load it.
 *
 * Opening the page only ASKS (a GET). Mail clients and link scanners open links too, so
 * nothing changes until the person presses the button (a POST).
 */

/** The function's machine-readable answer; the page branches on it, never on copy. */
export type UnsubscribeView = 'loading' | 'confirm' | 'working' | 'unsubscribed' | 'invalid' | 'rate_limited' | 'unavailable' | 'error';

export async function callUnsubscribe(token: string, method: 'GET' | 'POST'): Promise<UnsubscribeView> {
  try {
    const res = await publicEdgeFetch('email-unsubscribe', { method, query: { t: token } });
    if (res.status === 429) return 'rate_limited';
    if (res.status === 503) return 'unavailable';
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
    const state = body?.state;
    if (state === 'invalid') return 'invalid';
    if (method === 'GET' && (state === 'confirm' || state === 'unsubscribed')) return state;
    if (method === 'POST' && state === 'unsubscribed') return state;
    return 'error';
  } catch {
    return 'error';
  }
}

export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const { displayName } = usePublicBranding();
  const from = displayName ?? 'us';
  const [view, setView] = useState<UnsubscribeView>(token ? 'loading' : 'invalid');

  useEffect(() => {
    document.title = 'Unsubscribe';
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void callUnsubscribe(token, 'GET').then((state) => {
      if (!cancelled) setView(state);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function confirm() {
    setView('working');
    setView(await callUnsubscribe(token, 'POST'));
  }

  const body = 'text-[14px] leading-relaxed text-muted-foreground';

  return (
    <PublicPage title={TITLES[view]}>
      <div role="status" aria-live="polite" className="flex flex-col items-start gap-4">
        {view === 'loading' && <p className={body}>One moment.</p>}
        {view === 'confirm' && (
          <>
            <p className={body}>
              You will stop receiving group emails from {from}. Messages about your own account are not affected.
            </p>
            <Button onClick={() => void confirm()}>Unsubscribe</Button>
          </>
        )}
        {view === 'working' && <p className={body}>Taking you off the list.</p>}
        {view === 'unsubscribed' && (
          <p className={body}>You will not receive any more group emails from {from}. Messages about your own account are not affected.</p>
        )}
        {view === 'invalid' && (
          <p className={body}>It may have been cut off by your email program. Try the link again from the email, or reply to the email and ask to be removed.</p>
        )}
        {view === 'rate_limited' && <p className={body}>There have been too many requests from your network. Try again in a few minutes.</p>}
        {view === 'unavailable' && (
          <p className={body}>We could not process that just now. The link in your email still works, so try again in a few minutes.</p>
        )}
        {view === 'error' && (
          <>
            <p className={body}>Something went wrong. The link in your email still works.</p>
            <Button variant="outline" onClick={() => { setView('loading'); void callUnsubscribe(token, 'GET').then(setView); }}>
              Try again
            </Button>
          </>
        )}
      </div>
    </PublicPage>
  );
}

const TITLES: Record<UnsubscribeView, string> = {
  loading: 'Unsubscribe',
  confirm: 'Unsubscribe from group emails?',
  working: 'Unsubscribe',
  unsubscribed: 'You are unsubscribed',
  invalid: 'This link could not be read',
  rate_limited: 'Try again shortly',
  unavailable: 'Try again shortly',
  error: 'Something went wrong',
};
