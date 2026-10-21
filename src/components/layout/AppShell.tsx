import { Fragment, Suspense, useEffect, useId, useState } from 'react';
import { Link, Outlet, matchPath, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Moon, Settings, Sun } from 'lucide-react';
import { BottomBar } from '@/components/layout/BottomBar';
import { NewMenu } from '@/components/layout/NewMenu';
import { PAGE } from '@/components/layout/page';
import { RailSearch } from '@/components/layout/RailSearch';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Monogram, initialsOf } from '@/components/ui/monogram';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { links } from '@/features/links';
import { isBoundedPage, isWorkspacePage, navGroups, ownerNav, type NavGroup } from '@/features/registry';
import type { OwnerNavItem, ShellProps } from '@/features/types';
import { ThemeContext, useTheme, type ThemeControls } from '@/hooks/useTheme';
import { safeStorage, storageKey } from '@/lib/storage';
import { cn } from '@/lib/utils';

/**
 * The owner shell, in four zones: a permanent icon rail on the left (the organization, New,
 * search, the registry's nav with each count on its icon's corner, light/dark and the
 * account at the foot), the top bar, the content, and a bottom bar pinned to the window's
 * foot with the figures the features count. Below `md` the rail becomes a labelled drawer
 * opened from the top bar, and the bottom bar is not drawn.
 *
 * The top bar is a SLOT, not a component pages call: PageHeader portals a page's title and
 * actions into it. On desktop the bar hides while the slot is empty; on a phone it always
 * shows, because it carries the menu button. Pin something under the bar with
 * `top-[var(--topbar-h)]`.
 *
 * A workspace screen (the registry's `workspaceRoutes`) draws its own top: the tab strip is
 * the top row and the page's header sits under it, so there the shell draws no slot at all
 * (one id, one element) and, on desktop, no bar (`--topbar-h` is 0).
 *
 * A route with `handle: BOUNDED_PAGE`, and every workspace screen, gets a bounded page
 * instead: the content area is exactly the window between the bars and never scrolls
 * itself, so the page can give each of its areas its own ScrollArea. Otherwise the page
 * scrolls with the document and the bottom bar sticks to the window's foot.
 */

/** One drawer row: 32px, 13px label, 18px icon at a light stroke. */
const NAV_ROW =
  'flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:stroke-[1.75]';

/** One rail button: a 36px square around an 18px icon. */
const RAIL_BUTTON =
  'relative flex size-9 items-center justify-center rounded-md text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-[18px] [&>svg]:stroke-[1.75]';

const COLLAPSED_KEY = storageKey('nav', 'collapsed');

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Which section headings the owner has folded in the drawer, remembered in this browser. */
function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<string[]>(() => safeStorage.getJson(COLLAPSED_KEY, isStringList) ?? []);
  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    safeStorage.setJson(COLLAPSED_KEY, next);
    setCollapsed(next);
  };
  return { collapsed, toggle };
}

function matches(pathname: string, item: OwnerNavItem): boolean {
  return matchPath({ path: item.path, end: item.end ?? false }, pathname) !== null;
}

/**
 * Whether a nav item is the page you are on: its own path, or, for the workspace's item,
 * any workspace screen no other item claims (the board, requests, messages...).
 */
export function isNavItemOn(pathname: string, item: OwnerNavItem, items: readonly OwnerNavItem[] = ownerNav): boolean {
  if (matches(pathname, item)) return true;
  return !!item.workspace && isWorkspacePage(pathname) && !items.some((other) => other !== item && matches(pathname, other));
}

/** A nav item's live count. The count names itself (CountBadge's `title`). */
function NavBadge({ item, className }: { item: OwnerNavItem; className: string }) {
  const Badge = item.badge;
  if (!Badge) return null;
  return (
    <span className={cn('pointer-events-none absolute flex', className)}>
      <Suspense fallback={null}>
        <Badge />
      </Suspense>
    </span>
  );
}

function DrawerRow({ item, onNavigate }: { item: OwnerNavItem; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const on = isNavItemOn(pathname, item);
  const { label, icon: Icon, path } = item;
  return (
    <li className="relative">
      <Link
        to={path}
        onClick={onNavigate}
        aria-current={on ? 'page' : undefined}
        className={cn(
          NAV_ROW,
          'text-sidebar-foreground hover:bg-sidebar-accent',
          item.badge && 'pr-9',
          on && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
        )}
      >
        <Icon aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
      {/* Beside the link, not inside it, so the link's name stays its label. */}
      <NavBadge item={item} className="right-2 top-1/2 -translate-y-1/2" />
    </li>
  );
}

function DrawerNav({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { collapsed, toggle } = useCollapsedSections();
  const idBase = useId();

  return (
    <nav aria-label="Main" className="flex flex-col px-2 py-1">
      {groups.map((group) => {
        // A folded section that holds the page you are on would hide the highlighted row,
        // so it stays open; the stored preference is untouched.
        const holdsActive = group.items.some((item) => isNavItemOn(pathname, item));
        const folded = group.key !== null && !holdsActive && collapsed.includes(group.key);
        const listId = `${idBase}-${group.key ?? 'top'}`;
        return (
          <div key={group.key ?? 'top'} className="py-1">
            {group.key !== null && (
              <button
                type="button"
                aria-expanded={!folded}
                aria-controls={listId}
                onClick={() => toggle(group.key as string)}
                className="mt-2 flex h-7 w-full select-none items-center rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-sidebar-foreground"
              >
                <span>{group.label}</span>
                <ChevronDown aria-hidden="true" className={cn('ml-auto size-3.5 transition-transform', folded && '-rotate-90')} />
              </button>
            )}
            <ul id={listId} hidden={folded} className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <DrawerRow key={item.path} item={item} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** The phone drawer's contents: the organization, New, the labelled nav, light/dark, the account. */
function DrawerBody({ orgName, email, onSignOut, theme, onNavigate }: ShellProps & { theme: ThemeControls; onNavigate: () => void }) {
  const name = orgName ?? 'Open CRM';
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* Room on the right for the drawer's close button. */}
      <Link to="/" onClick={onNavigate} className="flex h-14 shrink-0 items-center gap-2 px-3 pr-10">
        <Monogram initials={initialsOf(name)} size="md" className="rounded-md" />
        <span className="min-w-0 truncate text-[13px] font-semibold">{name}</span>
      </Link>
      <div className="shrink-0 px-2 pb-1">
        <NewMenu />
      </div>
      <ScrollArea fitWidth className="min-h-0 flex-1">
        <DrawerNav groups={navGroups()} onNavigate={onNavigate} />
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border p-2">
        {/* Labelled by what a click does. */}
        <button
          type="button"
          onClick={theme.toggle}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          {theme.isDark ? <Sun className="size-3" aria-hidden="true" /> : <Moon className="size-3" aria-hidden="true" />}
          <span>{theme.isDark ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <div className="flex items-center gap-2 px-2 py-1">
          <Monogram initials={initialsOf(email)} size="sm" />
          <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">Signed in as {email}.</span>
        </div>
        <Button variant="outline" size="xs" className="w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** One rail icon: a link named by its label, the label as a tooltip, the count on the corner. */
function RailItem({ item }: { item: OwnerNavItem }) {
  const { pathname } = useLocation();
  const on = isNavItemOn(pathname, item);
  const { label, icon: Icon, path } = item;
  return (
    <li className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to={path} aria-current={on ? 'page' : undefined} className={cn(RAIL_BUTTON, on && 'bg-sidebar-accent text-sidebar-accent-foreground')}>
            <Icon aria-hidden="true" />
            {/* Named by its text, not aria-label, so a form's "Email" field is the only thing labelled Email. */}
            <span className="sr-only">{label}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      {/* Drawn ONCE, on the icon's corner, smaller than a row's chip. */}
      <NavBadge item={item} className="-right-1 -top-1 [&>span]:h-[15px] [&>span]:min-w-[15px] [&>span]:px-[3px] [&>span]:text-[9px]" />
    </li>
  );
}

/** The desktop rail: never folds, never labels; every group is a run of icons under a hairline. */
function Rail({ orgName, email, onSignOut, theme }: ShellProps & { theme: ThemeControls }) {
  const name = orgName ?? 'Open CRM';
  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-1 bg-sidebar py-2 text-sidebar-foreground">
      <Link to="/" aria-label={name} title={name} className="mb-1 flex size-9 items-center justify-center rounded-md hover:bg-sidebar-accent">
        <Monogram initials={initialsOf(name)} size="md" className="rounded-md" />
      </Link>
      <NewMenu compact />
      <RailSearch />
      <ScrollArea className="min-h-0 w-full flex-1">
        <nav aria-label="Main" className="flex flex-col items-center py-1">
          {navGroups().map((group, i) => (
            <Fragment key={group.key ?? 'top'}>
              {i > 0 && <div aria-hidden="true" className="my-1.5 h-px w-6 bg-sidebar-border" />}
              <ul aria-label={group.label ?? undefined} className="flex flex-col items-center gap-1">
                {group.items.map((item) => (
                  <RailItem key={item.path} item={item} />
                ))}
              </ul>
            </Fragment>
          ))}
        </nav>
      </ScrollArea>
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border pt-2">
        {/* Labelled by what a click does. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={theme.isDark ? 'Light mode' : 'Dark mode'}
          title={theme.isDark ? 'Light mode' : 'Dark mode'}
          onClick={theme.toggle}
          className="size-9 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          {theme.isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title={email} className={RAIL_BUTTON}>
              <Monogram initials={initialsOf(email)} size="sm" />
              {/* The button's name: who is signed in, said once. */}
              <span className="sr-only">Signed in as {email}.</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-60">
            <DropdownMenuLabel className="text-[12px] font-normal text-muted-foreground [overflow-wrap:anywhere]">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link to={links.settings()}>
                <Settings className="mr-2 size-4" aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSignOut} className="cursor-pointer">
              <LogOut className="mr-2 size-4" aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function AppShell(props: ShellProps) {
  const { isDark, toggle } = useTheme();
  const theme: ThemeControls = { isDark, toggle };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname, key: locationKey } = useLocation();
  // Any move to another screen closes the drawer: its own rows, a New entry, and a dialog
  // opened from it that goes on to a screen (Request's Next).
  useEffect(() => setDrawerOpen(false), [locationKey]);
  const workspace = isWorkspacePage(pathname);
  const bounded = workspace || isBoundedPage(pathname);

  return (
    <ThemeContext.Provider value={theme}>
      <TooltipProvider delayDuration={300}>
        <div className="flex min-h-svh w-full bg-background text-foreground">
          <aside className="sticky top-0 hidden h-svh w-14 shrink-0 border-r border-sidebar-border md:block">
            <Rail {...props} theme={theme} />
          </aside>

          {/* overflow-x-clip, not overflow-hidden: no sideways scroll, and no scroll container
              that would stop the top bar from sticking to the viewport. */}
          <main
            data-bounded={bounded || undefined}
            data-workspace={workspace || undefined}
            className={cn(
              'flex min-w-0 flex-1 flex-col overflow-x-clip text-[14px] leading-[1.5] [--bottombar-h:0px] [--topbar-h:2.5rem] md:[--bottombar-h:1.75rem]',
              workspace ? 'md:[--topbar-h:0px]' : 'md:[--topbar-h:3rem]',
              bounded ? 'h-svh overflow-hidden' : 'min-h-svh',
            )}
          >
            {/* The id in `has-[#app-topbar-slot:empty]` is TOPBAR_SLOT_ID written out: Tailwind
                cannot read a variable. AppShell.test.tsx keeps the two in step. */}
            <div
              className={cn(
                'sticky top-0 z-30 flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:px-5 md:has-[#app-topbar-slot:empty]:hidden',
                workspace && 'md:hidden',
              )}
            >
              <Button variant="ghost" size="icon-sm" className="-ml-1 md:hidden" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
                <Menu />
              </Button>
              {!workspace && <div id={TOPBAR_SLOT_ID} className="flex min-w-0 flex-1 items-center" />}
            </div>
            <div className={cn('flex min-w-0 flex-1 flex-col', bounded && 'min-h-0')}>
              <Suspense
                fallback={
                  <div className={PAGE}>
                    <p className="text-[13px] text-muted-foreground">Loading...</p>
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            </div>
            <BottomBar />
          </main>
        </div>

        {/* The phone drawer. Its contents mount only while it is open. */}
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="w-[208px] max-w-[85vw] p-0 sm:max-w-[208px]">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Every section of the app, and your account.</SheetDescription>
            <DrawerBody {...props} theme={theme} onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
      </TooltipProvider>
    </ThemeContext.Provider>
  );
}
