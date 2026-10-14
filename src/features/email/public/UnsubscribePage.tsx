import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: the one-click unsubscribe link in every group email. The email feature replaces it. */
export function UnsubscribePage() {
  return (
    <PublicPage title="Unsubscribe">
      <p className="text-[14px] text-muted-foreground">Stop receiving group emails from us.</p>
    </PublicPage>
  );
}
