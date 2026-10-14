import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { portalTabs } from '@/features/registry';
import type { ShellProps } from '@/features/types';
import { cn } from '@/lib/utils';

/**
 * The client portal's frame (minimal; the portal feature fleshes it out): a header with the
 * organization's name and Sign out, and the registry's portal tabs. One tab bar, placed by
 * CSS: pinned to the bottom of the screen on a phone, under the header from `md` up.
 */
export function PortalLayout({ orgName, email, onSignOut }: ShellProps) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{orgName ?? ''}</span>
          <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground sm:block">Signed in as {email}.</span>
          <Button variant="outline" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
        <nav
          aria-label="Portal"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:static md:border-t-0 md:pb-0"
        >
          <ul className="mx-auto flex w-full max-w-5xl md:gap-1 md:px-3">
            {portalTabs.map(({ label, icon: Icon, path, end, badge: Badge }) => (
              <li key={path} className="min-w-0 flex-1 md:flex-none">
                <NavLink
                  to={path}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 px-2 text-[11px] text-muted-foreground hover:text-foreground',
                      'md:h-10 md:flex-row md:gap-2 md:border-b-2 md:border-transparent md:px-3 md:text-[13px]',
                      isActive && 'font-medium text-foreground md:border-foreground',
                    )
                  }
                >
                  <Icon className="size-5 shrink-0 stroke-[1.75] md:size-4" aria-hidden="true" />
                  <span className="max-w-full truncate">{label}</span>
                  {Badge && (
                    <Suspense fallback={null}>
                      <Badge />
                    </Suspense>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {/* Bottom padding on a phone clears the fixed tab bar. */}
      <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 overflow-x-clip px-4 pb-20 pt-4 text-[14px] md:pb-8">
        <Suspense fallback={<p className="text-[13px] text-muted-foreground">Loading...</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
