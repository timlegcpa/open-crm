import { Suspense, useId, useState } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Monogram, initialsOf } from '@/components/ui/monogram';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { PAGE } from '@/components/layout/page';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';
import { isBoundedPage, navGroups, type NavGroup } from '@/features/registry';
import type { OwnerNavItem, ShellProps } from '@/features/types';
import { ThemeContext, useTheme, type ThemeControls } from '@/hooks/useTheme';
import { safeStorage, storageKey } from '@/lib/storage';
import { cn } from '@/lib/utils';

/**
 * The owner shell: a 208px rail (the organization at the top, the registry's nav grouped by
 * section, light/dark and the account at the foot) beside the content, which scrolls with
 * the document. Below `md` the rail becomes a drawer opened from the top bar.
 *
 * The top bar is a SLOT, not a component pages call: PageHeader portals a page's title and
 * actions into it. On desktop the bar hides while the slot is empty (a page that draws its
 * own full-height layout); on a phone it always shows, because it carries the menu button.
 * Pin something under the bar with `top-[var(--topbar-h)]`.
 *
 * A route with `handle: BOUNDED_PAGE` gets a bounded page instead: the content area is
 * exactly the window below the top bar and never scrolls itself, so the page (a board) can
 * give each of its areas its own ScrollArea. The page's root should be `h-full min-h-0`.
 */

/** One nav row: 32px, 13px label, 18px icon at a light stroke. */
const NAV_ROW =
  'flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:stroke-[1.75]';

const COLLAPSED_KEY = storageKey('nav', 'collapsed');

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Which section headings the owner has folded, remembered in this browser. */
function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<string[]>(() => safeStorage.getJson(COLLAPSED_KEY, isStringList) ?? []);
  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    safeStorage.setJson(COLLAPSED_KEY, next);
    setCollapsed(next);
  };
  return { collapsed, toggle };
}

function isOn(pathname: string, item: OwnerNavItem): boolean {
  return matchPath({ path: item.path, end: item.end ?? false }, pathname) !== null;
}

function NavRow({ item, onNavigate }: { item: OwnerNavItem; onNavigate?: () => void }) {
  const { label, icon: Icon, path, end, badge: Badge } = item;
  return (
    <li className="relative">
      <NavLink
        to={path}
        end={end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            NAV_ROW,
            'text-sidebar-foreground hover:bg-sidebar-accent',
            Badge && 'pr-9',
            isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
          )
        }
      >
        <Icon aria-hidden="true" />
        <span className="truncate">{label}</span>
      </NavLink>
      {Badge && (
        // Beside the link, not inside it, so the link's name stays its label. The count
        // names itself (CountBadge's `title`).
        <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2">
          <Suspense fallback={null}>
            <Badge />
          </Suspense>
        </span>
      )}
    </li>
  );
}

function SidebarNav({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { collapsed, toggle } = useCollapsedSections();
  const idBase = useId();

  return (
    <nav aria-label="Main" className="flex flex-col px-2 py-1">
      {groups.map((group) => {
        // A folded section that holds the page you are on would hide the highlighted row,
        // so it stays open; the stored preference is untouched.
        const holdsActive = group.items.some((item) => isOn(pathname, item));
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
                <NavRow key={item.path} item={item} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** The rail's contents, shared by the desktop rail and the phone drawer. */
function SidebarBody({
  orgName,
  email,
  onSignOut,
  theme,
  drawer = false,
  onNavigate,
}: ShellProps & { theme: ThemeControls; drawer?: boolean; onNavigate?: () => void }) {
  const name = orgName ?? 'Open CRM';
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* In the drawer, room on the right for the drawer's close button. */}
      <Link to="/" onClick={onNavigate} className={cn('flex h-14 shrink-0 items-center gap-2 px-3', drawer && 'pr-10')}>
        <Monogram initials={initialsOf(name)} size="md" className="rounded-md" />
        <span className="min-w-0 truncate text-[13px] font-semibold">{name}</span>
      </Link>
      <ScrollArea fitWidth className="min-h-0 flex-1">
        <SidebarNav groups={navGroups()} onNavigate={onNavigate} />
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
          <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            Signed in as {email}.
          </span>
        </div>
        <Button variant="outline" size="xs" className="w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

export function AppShell(props: ShellProps) {
  const { isDark, toggle } = useTheme();
  const theme: ThemeControls = { isDark, toggle };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const bounded = isBoundedPage(useLocation().pathname);

  return (
    <ThemeContext.Provider value={theme}>
      <div className="flex min-h-svh w-full bg-background text-foreground">
        <aside className="sticky top-0 hidden h-svh w-[208px] shrink-0 border-r border-sidebar-border md:block">
          <SidebarBody {...props} theme={theme} />
        </aside>

        {/* overflow-x-clip, not overflow-hidden: no sideways scroll, and no scroll container
            that would stop the top bar from sticking to the viewport. */}
        <main
          data-bounded={bounded || undefined}
          className={cn(
            'min-w-0 flex-1 overflow-x-clip text-[14px] leading-[1.5] [--topbar-h:2.5rem] md:[--topbar-h:3rem]',
            bounded && 'flex h-svh flex-col overflow-hidden',
          )}
        >
          {/* The id in `has-[#app-topbar-slot:empty]` is TOPBAR_SLOT_ID written out: Tailwind
              cannot read a variable. AppShell.test.tsx keeps the two in step. */}
          <div className="sticky top-0 z-30 flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:px-5 md:has-[#app-topbar-slot:empty]:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-1 md:hidden"
              aria-label="Open menu"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu />
            </Button>
            <div id={TOPBAR_SLOT_ID} className="flex min-w-0 flex-1 items-center" />
          </div>
          <Suspense
            fallback={
              <div className={PAGE}>
                <p className="text-[13px] text-muted-foreground">Loading...</p>
              </div>
            }
          >
            {bounded ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <Outlet />
              </div>
            ) : (
              <Outlet />
            )}
          </Suspense>
        </main>
      </div>

      {/* The phone drawer. Its contents mount only while it is open. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-[208px] max-w-[85vw] p-0 sm:max-w-[208px]">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">Every section of the app, and your account.</SheetDescription>
          <SidebarBody {...props} theme={theme} drawer onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>
    </ThemeContext.Provider>
  );
}
