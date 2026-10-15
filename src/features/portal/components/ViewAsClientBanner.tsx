import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { links } from '@/features/links';
import { toast } from '@/components/ui/sonner';
import { useAuth, ViewNotEndedError } from '@/lib/auth';

/**
 * Leave View as client: the owner's own session comes back in this browser, the client session
 * the view used is revoked, and the owner lands on that contact's record. A full page load,
 * so nothing the client's view cached survives into the owner's app. Resolves false, with a
 * toast, when the view could not be ended and is still on.
 */
export function useExitViewAsClient(): () => Promise<boolean> {
  const { viewAsClient, endViewAsClient } = useAuth();
  const contactId = viewAsClient?.contactId ?? null;
  return useCallback(async () => {
    try {
      await endViewAsClient();
    } catch (err) {
      // Still live (the server could not revoke the client session): stay, and say so.
      toast.error(err instanceof ViewNotEndedError ? err.message : 'View as client could not be ended. Try again in a moment.');
      return false;
    }
    window.location.replace(contactId ? links.contact(contactId) : links.contacts());
    return true;
  }, [contactId, endViewAsClient]);
}

/**
 * Pinned to the top of the window while the owner views the portal as a client. It says the
 * view is read-only, and pads the page by its own height so it never covers the letterhead.
 */
export function ViewAsClientBanner() {
  const { viewAsClient, isViewAsClientSession } = useAuth();
  const exit = useExitViewAsClient();
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.body.style.paddingTop;
    const apply = () => {
      document.body.style.paddingTop = `${element.offsetHeight}px`;
    };
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      document.body.style.paddingTop = previous;
    };
  }, []);

  if (!isViewAsClientSession) return null;
  return (
    <div
      ref={ref}
      role="status"
      className="fixed inset-x-0 top-0 z-[100] border-b border-border bg-foreground text-background"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]">
        <Eye className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          {viewAsClient ? (
            <>
              Viewing as <span className="font-semibold">{viewAsClient.contactName}</span>.
            </>
          ) : (
            'Viewing as a client.'
          )}{' '}
          Read-only: nothing here changes their account.
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void exit().then((left) => {
              if (!left) setLeaving(false);
            });
          }}
        >
          {leaving ? 'Leaving...' : 'Exit'}
        </Button>
      </div>
    </div>
  );
}
