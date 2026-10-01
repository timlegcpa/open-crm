import { NavLink, Outlet } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** One entry per section. Later sections (marketing, billing...) are added here. */
const NAV_ITEMS: NavItem[] = [{ to: '/contacts', label: 'Contacts', icon: Users }];

export function AppShell({
  orgName,
  email,
  onSignOut,
}: {
  orgName: string | null;
  email: string;
  onSignOut: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <span className="font-semibold">{orgName ?? 'Open CRM'}</span>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Signed in as {email}.</span>
          <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Main" className="border-b p-2 md:w-48 md:border-b-0 md:border-r">
          <ul className="flex gap-1 md:flex-col">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
                      isActive && 'bg-accent font-medium',
                    )
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
