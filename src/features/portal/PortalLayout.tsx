import { Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, LogOut, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { links } from '@/features/links';
import { portalTabs } from '@/features/registry';
import type { PortalTab, ShellProps } from '@/features/types';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { getMyContact, portalKeys } from './api';
import { hiddenPortalPaths, isHiddenPortalPath, readSidebarConfig } from './lib/portalAccess';
import { useInactivityTimeout } from './components/useInactivityTimeout';
import { usePortalMeta } from './components/usePortalMeta';
import { ViewAsClientBanner, useExitViewAsClient } from './components/ViewAsClientBanner';

/** Tabs across a phone, besides the last slot, which always opens the "More" sheet. */
const PHONE_TAB_SLOTS = 3;

/**
 * The client portal's frame: a letterhead with the organization's name and the account
 * menu, the sections (a rail on a desktop when there is more than one; tabs along the bottom
 * of a phone, whose last slot opens a sheet with the rest, the account and Sign out), the
 * View-as-client banner, a 30-minute inactivity sign-out and
 * the noindex / no-referrer meta while inside the portal.
 *
 * It is also the route gate for the owner's per-contact switches: a hidden section's page,
 * and anything under it, redirects to Home, so a typed address cannot open what the
 * navigation leaves out.
 */
export function PortalLayout({ orgName, email, onSignOut }: ShellProps) {
  const { isViewAsClientSession: viewing, expireSession } = useAuth();
  const location = useLocation();
  const contact = useQuery({ queryKey: portalKeys.myContact(), queryFn: getMyContact });
  const exitView = useExitViewAsClient();

  usePortalMeta();
  useInactivityTimeout(() => (viewing ? exitView() : expireSession()));

  // A new page starts at the top of the window, not where the last one was scrolled to.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const hidden = useMemo(
    // Fail open when the contact cannot be read: hiding is the owner's preference for the
    // navigation, not a permission. What a client may read is decided by RLS either way.
    () => hiddenPortalPaths(readSidebarConfig(contact.data?.portal_sidebar_config)),
    [contact.data],
  );
  const tabs = useMemo(() => portalTabs.filter((tab) => !isHiddenPortalPath(tab.path, hidden)), [hidden]);

  // Nothing renders until the switches are known, so a hidden page never flashes.
  if (contact.isPending) {
    return (
      <main className="flex min-h-svh items-center justify-center p-4">
        <p className="text-muted-foreground">Loading...</p>
      </main>
    );
  }
  if (isHiddenPortalPath(location.pathname, hidden)) return <Navigate to={links.portalHome()} replace />;

  const signOut = () => {
    if (viewing) void exitView();
    else onSignOut();
  };

  // One TooltipProvider for every portal page, as the owner shell has (OwnerApp).
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-svh flex-col bg-background text-foreground">
        {viewing && <ViewAsClientBanner />}
        <header data-portal-chrome className="border-b border-border bg-background">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{orgName ?? ''}</span>
            <AccountMenu email={email} onSignOut={signOut} />
          </div>
        </header>
        <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-1">
          {tabs.length > 1 && <SectionRail tabs={tabs} />}
          {/* Bottom padding on a phone clears the fixed tab bar. */}
          <main className="w-full min-w-0 flex-1 overflow-x-clip px-4 pb-24 pt-4 text-[14px] md:pb-8">
            <Suspense fallback={<p className="text-[13px] text-muted-foreground">Loading...</p>}>
              <Outlet />
            </Suspense>
          </main>
        </div>
        <BottomTabs tabs={tabs} onSignOut={signOut} />
      </div>
    </TooltipProvider>
  );
}

function TabBadge({ tab }: { tab: PortalTab }) {
  const Badge = tab.badge;
  if (!Badge) return null;
  return (
    <Suspense fallback={null}>
      <Badge />
    </Suspense>
  );
}

function SectionRail({ tabs }: { tabs: PortalTab[] }) {
  return (
    <nav data-portal-chrome aria-label="Portal sections" className="hidden w-48 shrink-0 border-r border-border py-4 pr-3 md:block">
      <ul className="flex flex-col gap-0.5">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <li key={tab.path}>
              <NavLink
                to={tab.path}
                end={tab.end}
                className={({ isActive }) =>
                  cn(
                    'flex h-9 items-center gap-2 rounded-md px-3 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground',
                    isActive && 'bg-secondary font-medium text-foreground',
                  )
                }
              >
                <Icon className="size-4 shrink-0 stroke-[1.75]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                <TabBadge tab={tab} />
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const PHONE_TAB_CLASS =
  'relative flex h-14 w-full min-w-0 flex-col items-center justify-center gap-0.5 px-2 text-[11px] text-muted-foreground hover:text-foreground';

function BottomTabs({ tabs, onSignOut }: { tabs: PortalTab[]; onSignOut: () => void }) {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const shown = tabs.slice(0, PHONE_TAB_SLOTS);
  const rest = tabs.slice(PHONE_TAB_SLOTS);

  // The sheet closes when its link has been followed.
  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  return (
    <nav
      data-portal-chrome
      aria-label="Portal"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex w-full">
        {shown.map((tab) => {
          const Icon = tab.icon;
          return (
            <li key={tab.path} className="min-w-0 flex-1">
              <NavLink to={tab.path} end={tab.end} className={({ isActive }) => cn(PHONE_TAB_CLASS, isActive && 'font-medium text-foreground')}>
                <Icon className="size-5 shrink-0 stroke-[1.75]" aria-hidden="true" />
                <span className="max-w-full truncate">{tab.label}</span>
                <TabBadge tab={tab} />
              </NavLink>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          <button type="button" className={PHONE_TAB_CLASS} onClick={() => setMoreOpen(true)}>
            <Ellipsis className="size-5 shrink-0 stroke-[1.75]" aria-hidden="true" />
            <span>More</span>
          </button>
        </li>
      </ul>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
            <SheetDescription className="sr-only">The rest of the portal, your account and Sign out.</SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-0.5 py-2">
            {rest.map((tab) => {
              const Icon = tab.icon;
              return (
                <li key={tab.path}>
                  <NavLink to={tab.path} end={tab.end} className="flex h-11 items-center gap-3 rounded-md px-3 text-[14px] hover:bg-secondary">
                    <Icon className="size-5 shrink-0 stroke-[1.75]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                    <TabBadge tab={tab} />
                  </NavLink>
                </li>
              );
            })}
            <li>
              <NavLink to={links.portalProfile()} className="flex h-11 items-center gap-3 rounded-md px-3 text-[14px] hover:bg-secondary">
                <UserRound className="size-5 shrink-0 stroke-[1.75]" aria-hidden="true" />
                <span>Your account</span>
              </NavLink>
            </li>
            <li>
              <button type="button" onClick={onSignOut} className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-[14px] hover:bg-secondary">
                <LogOut className="size-5 shrink-0 stroke-[1.75]" aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </li>
          </ul>
        </SheetContent>
      </Sheet>
    </nav>
  );
}

function AccountMenu({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Your account">
          <UserRound className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Your account</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to={links.portalProfile()}>Profile</NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
