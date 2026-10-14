import type { ReactNode } from 'react';
import { usePublicBranding } from '@/hooks/usePublicBranding';
import { cn } from '@/lib/utils';

/**
 * THE frame for a public page (signing, verification, unsubscribe, start links,
 * invitations, password reset): the organization's name across the top, the page's title
 * and its content in a centred column. It reads branding through a plain fetch
 * (usePublicBranding), never supabase-js, so it is safe on a page with no session.
 *
 *   <PublicPage title="Unsubscribe">
 *     <p>...</p>
 *   </PublicPage>
 *
 * `width="wide"` gives a document viewer (the signer) room; the default suits a form.
 */
export function PublicPage({
  title,
  children,
  width = 'narrow',
}: {
  title?: string;
  children: ReactNode;
  width?: 'narrow' | 'wide';
}) {
  const { displayName } = usePublicBranding();
  const column = width === 'wide' ? 'max-w-5xl' : 'max-w-xl';

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className={cn('mx-auto flex h-14 w-full items-center px-4', column)}>
          {/* Decoration: blank until the name loads, and blank if it never does. */}
          <span className="truncate text-[15px] font-semibold">{displayName ?? ''}</span>
        </div>
      </header>
      <main className={cn('mx-auto w-full min-w-0 flex-1 px-4 py-8', column)}>
        {title && <h1 className="mb-4 text-xl font-semibold">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
