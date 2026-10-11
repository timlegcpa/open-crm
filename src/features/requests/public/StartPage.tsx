import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: a start link sent to a contact with no portal account. The requests feature replaces it. */
export function StartPage() {
  return (
    <PublicPage title="Your request">
      <p className="text-[14px] text-muted-foreground">The items you were asked for will appear here.</p>
    </PublicPage>
  );
}
