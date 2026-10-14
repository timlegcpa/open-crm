import { Suspense } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PAGE, PageHeader } from '@/components/layout/page';
import { links } from '@/features/links';
import { settingsSections } from '@/features/registry';
import { cn } from '@/lib/utils';

// Placeholders: the settings feature replaces these. The page already composes the
// registry's `settingsSections`, so a feature's section shows up here as soon as it is
// registered.

export function SettingsPage() {
  const { section } = useParams();
  const current = section === undefined ? settingsSections[0] : settingsSections.find((s) => s.key === section);

  return (
    <>
      <PageHeader title="Settings" />
      <div className={cn(PAGE, 'flex flex-col gap-4 md:flex-row')}>
        <nav aria-label="Settings sections" className="md:w-48 md:shrink-0">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {settingsSections.map(({ key, label }) => (
              <li key={key}>
                <Link
                  to={links.settingsSection(key)}
                  aria-current={current?.key === key ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent',
                    current?.key === key && 'bg-accent font-medium',
                  )}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="min-w-0 flex-1">
          {current ? (
            <Suspense fallback={null}>
              <current.Component />
            </Suspense>
          ) : (
            <p className="text-[13px] text-muted-foreground">There is no settings section at this address.</p>
          )}
        </section>
      </div>
    </>
  );
}

export function ProfileSettings() {
  return <p className="text-[13px] text-muted-foreground">The organization's name, logo and contact details.</p>;
}

export function SecuritySettings() {
  return <p className="text-[13px] text-muted-foreground">Your password and authenticator app.</p>;
}
