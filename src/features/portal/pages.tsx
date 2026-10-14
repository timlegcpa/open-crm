import { Suspense } from 'react';
import { portalHomeCards } from '@/features/registry';
import type { ContactTabProps } from '@/features/types';

// Placeholders: the portal feature replaces these.

/** The portal's Home: one card per feature that has something for the client (portalHomeCards). */
export function PortalHomePage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Home</h1>
      {portalHomeCards.map(({ key, Component }) => (
        <section key={key} className="rounded-lg border border-border bg-card p-4">
          <Suspense fallback={null}>
            <Component />
          </Suspense>
        </section>
      ))}
    </div>
  );
}

export function PortalProfilePage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Profile</h1>
      <p className="text-[13px] text-muted-foreground">Your contact details and sign-in settings will be here.</p>
    </div>
  );
}

export function PortalAccessTab(_props: ContactTabProps) {
  return <p className="text-[13px] text-muted-foreground">This contact's portal access will be managed here.</p>;
}
